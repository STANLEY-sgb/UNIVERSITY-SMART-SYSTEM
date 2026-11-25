import { randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BiometricOutcome, Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret } from '@kiu/security';
import { ENV, Env } from '../../config/env';
import { PageQuery, paged } from '../../common/pagination';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FaceAdapter, MockFaceAdapter } from './mock-adapter';

/** Notice shown while face enrolment is compulsory (the current institutional decision, D-039). */
export const NOTICE_VERSION = 'KIU-FACE-NOTICE-2026-02-prototype-compulsory';
/** Notice used if the institution switches the requirement off: enrolment is then voluntary and rests on consent. */
export const NOTICE_VERSION_VOLUNTARY = 'KIU-FACE-NOTICE-2026-01-prototype';

export const POLICY_DEFAULTS = { MATCH_THRESHOLD: 0.9, FACE_ENABLED: true, ENROLMENT_REQUIRED: true, ENFORCE_FROM: null } as const;
type PolicyValue = number | boolean | string | null;
/** Failed face checks (no match / liveness) against one student before face is paused for them. Card and QR stay open. */
export const FAIL_LIMIT = 5;
export const FAIL_WINDOW_MS = 10 * 60_000;
export type PolicyKey = keyof typeof POLICY_DEFAULTS;

export type FaceVerifyResult =
  | { outcome: 'MATCH'; studentId: string; score: number; latencyMs: number }
  | { outcome: Exclude<BiometricOutcome, 'MATCH'>; studentId?: undefined; score?: number; latencyMs: number; detail?: string };

const aad = (enrollmentId: string) => `bio:${enrollmentId}`;

@Injectable()
export class BiometricsService {
  readonly adapter: FaceAdapter = new MockFaceAdapter();

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(ENV) private readonly env: Env) {}

  // ───────────────────────── policy ─────────────────────────

  async policy(): Promise<Record<PolicyKey, PolicyValue>> {
    const rows = await this.prisma.biometricPolicy.findMany();
    const out: Record<string, unknown> = { ...POLICY_DEFAULTS };
    for (const r of rows) if (r.key in POLICY_DEFAULTS) out[r.key] = r.value;
    return out as Record<PolicyKey, PolicyValue>;
  }

  async setPolicy(patch: { matchThreshold?: number | undefined; faceEnabled?: boolean | undefined; enrolmentRequired?: boolean | undefined; enforceFrom?: string | null | undefined }, reason: string, actor: AuthUser, meta: RequestMeta) {
    const before = await this.policy();
    const next: Partial<Record<PolicyKey, PolicyValue>> = {};
    if (patch.matchThreshold !== undefined) next.MATCH_THRESHOLD = patch.matchThreshold;
    if (patch.faceEnabled !== undefined) next.FACE_ENABLED = patch.faceEnabled;
    if (patch.enrolmentRequired !== undefined) next.ENROLMENT_REQUIRED = patch.enrolmentRequired;
    if (patch.enforceFrom !== undefined) next.ENFORCE_FROM = patch.enforceFrom;
    await this.prisma.$transaction(async (tx) => {
      for (const [key, value] of Object.entries(next)) {
        const v = (value === null ? Prisma.JsonNull : value) as Prisma.InputJsonValue;
        await tx.biometricPolicy.upsert({ where: { key }, update: { value: v, updatedBy: actor.id }, create: { key, value: v, updatedBy: actor.id } });
      }
      await this.audit.record({ actorId: actor.id, action: 'biometrics.policy_changed', entityType: 'BiometricPolicy', before, after: next, reason, requestMeta: meta }, tx);
    });
    return this.policy();
  }

  // ───────────────────────── model version ─────────────────────────

  private modelVersion() {
    const a = this.adapter;
    return this.prisma.biometricModelVersion.upsert({
      where: { name_version: { name: a.name, version: a.version } }, update: {}, create: { name: a.name, version: a.version, isMock: a.isMock },
    });
  }

  // ───────────────────────── enrolment / revocation ─────────────────────────

  async enrol(dto: { regNo: string; noticeVersion: string; frames: unknown }, actor: AuthUser, meta: RequestMeta) {
    const required = (await this.policy()).ENROLMENT_REQUIRED === true;
    if (dto.noticeVersion !== (required ? NOTICE_VERSION : NOTICE_VERSION_VOLUNTARY)) throw new ConflictException({ code: 'NOTICE_OUTDATED', message: 'The privacy notice shown to the student is out of date. Reload and show the current notice.' });
    const student = await this.prisma.student.findFirst({ where: { regNo: dto.regNo, deletedAt: null } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    if (student.accountStatus !== 'ACTIVE') throw new ConflictException({ code: 'STUDENT_NOT_ACTIVE', message: 'Only active students can enrol' });
    if (await this.prisma.biometricEnrollment.count({ where: { studentId: student.id, status: 'ACTIVE' } })) {
      throw new ConflictException({ code: 'ALREADY_ENROLLED', message: 'This student already has an active face enrolment. Revoke it first to re-enrol.' });
    }
    const x = this.adapter.extract(dto.frames);
    if (!x.ok) throw new UnprocessableEntityException({ code: `FACE_${x.failure}`, message: this.failureMessage(x.failure, x.detail), details: { detail: x.detail } });
    const model = await this.modelVersion();
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.biometricEnrollment.create({ data: { studentId: student.id, status: 'ACTIVE', enrolledBy: actor.id, enrolledAt: new Date(), qualityMeta: { quality: x.quality } } });
      await tx.biometricTemplate.create({ data: { enrollmentId: e.id, modelVersionId: model.id, encryptedTemplateRef: encryptSecret(JSON.stringify(x.template), this.env.DATA_ENCRYPTION_KEY, aad(e.id)) } });
      await tx.biometricConsent.create({ data: { enrollmentId: e.id, status: 'GRANTED', noticeVersion: dto.noticeVersion, lawfulBasis: required ? 'INSTITUTIONAL_REQUIREMENT' : 'CONSENT', recordedBy: actor.id } });
      const a = await this.audit.record({ actorId: actor.id, action: 'biometrics.enrolled', entityType: 'BiometricEnrollment', entityId: e.id, after: { regNo: student.regNo, noticeVersion: dto.noticeVersion, model: `${model.name}@${model.version}`, isMock: model.isMock }, requestMeta: meta }, tx);
      await tx.biometricEnrollment.update({ where: { id: e.id }, data: { auditRef: a.id } });
      await tx.notification.create({ data: { studentId: student.id, kind: 'FACE_ENROLLED', title: 'Face verification enabled', body: 'You enrolled for optional face verification. You can withdraw at any time in My face; cards and QR codes keep working.' } });
      return { id: e.id, status: 'ACTIVE' as const, isMock: model.isMock, quality: x.quality };
    });
  }

  /** Deletes every template and records why. Used by staff revocation and by the student's own withdrawal. */
  private async terminate(enrollmentId: string, initiatedBy: 'STUDENT' | 'ADMIN', reason: string, actor: AuthUser, meta: RequestMeta) {
    const e = await this.prisma.biometricEnrollment.findUnique({ where: { id: enrollmentId }, include: { student: true } });
    if (!e) throw new NotFoundException({ code: 'ENROLLMENT_NOT_FOUND', message: 'Enrolment not found' });
    if (e.status !== 'ACTIVE' && e.status !== 'SUSPENDED') throw new ConflictException({ code: 'NOT_ACTIVE', message: 'This enrolment is already revoked' });
    await this.prisma.$transaction(async (tx) => {
      await tx.biometricEnrollment.update({ where: { id: e.id }, data: { status: initiatedBy === 'STUDENT' ? 'DELETED' : 'REVOKED', revokedAt: new Date() } });
      await tx.biometricTemplate.updateMany({ where: { enrollmentId: e.id, deletedAt: null }, data: { deletedAt: new Date(), encryptedTemplateRef: 'DELETED' } });
      await tx.biometricConsent.create({ data: { enrollmentId: e.id, status: 'WITHDRAWN', noticeVersion: NOTICE_VERSION, lawfulBasis: 'WITHDRAWAL', recordedBy: actor.id } });
      await tx.biometricRevocation.create({ data: { enrollmentId: e.id, reason, initiatedBy, actorId: actor.id } });
      await this.audit.record({ actorId: actor.id, action: initiatedBy === 'STUDENT' ? 'biometrics.withdrawn' : 'biometrics.revoked', entityType: 'BiometricEnrollment', entityId: e.id, after: { regNo: e.student.regNo }, reason, requestMeta: meta }, tx);
      await tx.notification.create({ data: { studentId: e.studentId, kind: 'FACE_REMOVED', title: 'Face verification removed', body: 'Your face data was deleted. Your card and QR code are unaffected.' } });
    });
    return { id: e.id, deleted: true };
  }

  revoke(id: string, reason: string, actor: AuthUser, meta: RequestMeta) { return this.terminate(id, 'ADMIN', reason, actor, meta); }

  async withdrawOwn(actor: AuthUser, meta: RequestMeta) {
    if (!actor.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const e = await this.prisma.biometricEnrollment.findFirst({ where: { studentId: actor.studentId, status: { in: ['ACTIVE', 'SUSPENDED'] } } });
    if (!e) throw new NotFoundException({ code: 'NOT_ENROLLED', message: 'You have no face enrolment' });
    return this.terminate(e.id, 'STUDENT', 'Withdrawn by the student', actor, meta);
  }

  // ───────────────────────── read models (never include templates) ─────────────────────────

  async list(q: PageQuery & { status?: string | undefined }) {
    const where: Prisma.BiometricEnrollmentWhereInput = q.status ? { status: q.status as never } : {};
    const [total, rows] = await Promise.all([
      this.prisma.biometricEnrollment.count({ where }),
      this.prisma.biometricEnrollment.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize,
        select: { id: true, status: true, enrolledAt: true, lastVerifiedAt: true, revokedAt: true, student: { select: { regNo: true, fullName: true } }, templates: { select: { modelVersion: { select: { name: true, version: true, isMock: true } } }, take: 1 } },
      }),
    ]);
    return paged(rows.map((r) => ({ id: r.id, status: r.status, enrolledAt: r.enrolledAt, lastVerifiedAt: r.lastVerifiedAt, revokedAt: r.revokedAt, regNo: r.student.regNo, fullName: r.student.fullName, model: r.templates[0]?.modelVersion ?? null })), total, q);
  }

  async mine(actor: AuthUser) {
    if (!actor.studentId) throw new ForbiddenException({ code: 'NO_STUDENT_PROFILE', message: 'No student profile linked to this account' });
    const e = await this.prisma.biometricEnrollment.findFirst({ where: { studentId: actor.studentId, status: { in: ['ACTIVE', 'SUSPENDED'] } }, select: { id: true, status: true, enrolledAt: true, lastVerifiedAt: true } });
    const [p, ex] = await Promise.all([this.policy(), this.prisma.biometricExemption.findUnique({ where: { studentId: actor.studentId } })]);
    const exempt = !!ex && !ex.revokedAt;
    const required = p.ENROLMENT_REQUIRED === true;
    return {
      enrolled: !!e, enrollment: e, noticeVersion: required ? NOTICE_VERSION : NOTICE_VERSION_VOLUNTARY, prototypeOnly: this.adapter.isMock,
      required, enforceFrom: required ? (p.ENFORCE_FROM as string | null) : null, exempt, exemptReason: exempt ? ex!.reason : null,
      alternative: 'Your card and rotating QR code keep working while you are enrolled or exempt.',
    };
  }

  async devices() {
    const readers = await this.prisma.reader.findMany({ where: { supportsFace: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, status: true, faceAuth: { select: { revokedAt: true, approvedAt: true } } } });
    return readers.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, authorised: !!r.faceAuth && !r.faceAuth.revokedAt }));
  }

  async setDevice(readerId: string, authorised: boolean, reason: string, actor: AuthUser, meta: RequestMeta) {
    const reader = await this.prisma.reader.findUnique({ where: { id: readerId } });
    if (!reader) throw new NotFoundException({ code: 'READER_NOT_FOUND', message: 'Reader not found' });
    if (!reader.supportsFace) throw new ConflictException({ code: 'NO_FACE_SUPPORT', message: 'This reader is not registered as face-capable' });
    await this.prisma.$transaction(async (tx) => {
      await tx.biometricDeviceAuthorization.upsert({
        where: { readerId }, update: { revokedAt: authorised ? null : new Date(), approvedBy: actor.id, approvedAt: authorised ? new Date() : undefined },
        create: { readerId, approvedBy: actor.id, revokedAt: authorised ? null : new Date() },
      });
      await this.audit.record({ actorId: actor.id, action: authorised ? 'biometrics.device_authorised' : 'biometrics.device_revoked', entityType: 'Reader', entityId: readerId, reason, requestMeta: meta }, tx);
    });
    return { readerId, authorised };
  }

  // ───────────────────────── 1:1 verification (the reader path) ─────────────────────────

  async verifyOneToOne(reader: { id: string }, regNo: string, frames: unknown): Promise<FaceVerifyResult> {
    const t0 = performance.now();
    const done = async (outcome: BiometricOutcome, extra: { studentId?: string; score?: number; live?: boolean; detail?: string } = {}) => {
      const latencyMs = Math.round(performance.now() - t0);
      await this.prisma.biometricAttempt.create({ data: { readerId: reader.id, studentId: outcome === 'MATCH' ? extra.studentId ?? null : null, mode: 'ONE_TO_ONE', outcome, livenessOk: extra.live ?? null, latencyMs } });
      return (outcome === 'MATCH' ? { outcome, studentId: extra.studentId!, score: extra.score!, latencyMs } : { outcome, ...(extra.score !== undefined ? { score: extra.score } : {}), latencyMs, ...(extra.detail ? { detail: extra.detail } : {}) }) as FaceVerifyResult;
    };

    const policy = await this.policy();
    const [device, hw] = await Promise.all([
      this.prisma.biometricDeviceAuthorization.findUnique({ where: { readerId: reader.id } }),
      this.prisma.reader.findUnique({ where: { id: reader.id }, select: { supportsFace: true } }),
    ]);
    if (!policy.FACE_ENABLED || !hw?.supportsFace || !device || device.revokedAt) return done('ERROR', { detail: 'FACE_NOT_ENABLED' });

    // An unknown registration number looks exactly like "not enrolled": no account enumeration through the reader.
    const student = await this.prisma.student.findFirst({ where: { regNo, deletedAt: null }, select: { id: true } });
    const enrollment = student ? await this.prisma.biometricEnrollment.findFirst({ where: { studentId: student.id, status: { in: ['ACTIVE', 'SUSPENDED', 'REVOKED', 'DELETED'] } }, orderBy: { createdAt: 'desc' }, include: { templates: { where: { deletedAt: null }, take: 1 } } }) : null;
    if (!student || !enrollment) return done('NOT_ENROLLED');
    if (enrollment.status !== 'ACTIVE' || !enrollment.templates[0]) return done('CONSENT_REVOKED');

    // Brute-force guard: short-lived failure markers (purged by expiry, deleted on success) pause face for this student only.
    const prefix = `ff:${student.id}:`;
    const failures = await this.prisma.credentialNonce.count({ where: { scope: 'FACE_FAIL', nonce: { startsWith: prefix }, expiresAt: { gt: new Date() } } });
    if (failures >= FAIL_LIMIT) return done('ERROR', { detail: 'FACE_LOCKED' });
    const fail = async (outcome: 'NO_MATCH' | 'LIVENESS_FAILED', extra: { score?: number; live?: boolean; detail?: string }) => {
      await this.prisma.credentialNonce.create({ data: { nonce: `${prefix}${randomBytes(8).toString('hex')}`, scope: 'FACE_FAIL', expiresAt: new Date(Date.now() + FAIL_WINDOW_MS) } });
      if (failures + 1 === FAIL_LIMIT) {
        await this.prisma.securityAlert.create({ data: { kind: 'FACE_LOCKOUT', severity: 'MEDIUM', readerId: reader.id, studentId: student.id, detail: { failures: FAIL_LIMIT, windowMinutes: FAIL_WINDOW_MS / 60_000 } } }).catch(() => undefined);
      }
      return done(outcome, extra);
    };

    const x = this.adapter.extract(frames);
    if (!x.ok) {
      if (x.failure === 'LIVENESS_FAILED') return fail('LIVENESS_FAILED', { live: false, detail: x.detail });
      return done(x.failure === 'QUALITY_FAILED' ? 'QUALITY_FAILED' : 'ERROR', { detail: x.detail });
    }

    let stored: number[];
    try { stored = JSON.parse(decryptSecret(enrollment.templates[0].encryptedTemplateRef, this.env.DATA_ENCRYPTION_KEY, aad(enrollment.id))); } catch { return done('ERROR', { detail: 'TEMPLATE_UNREADABLE' }); }
    const score = Math.round(this.adapter.compare(x.template, stored) * 1000) / 1000;
    if (score < (policy.MATCH_THRESHOLD as number)) return fail('NO_MATCH', { score, live: true });
    await this.prisma.credentialNonce.deleteMany({ where: { scope: 'FACE_FAIL', nonce: { startsWith: prefix } } });
    await this.prisma.biometricEnrollment.update({ where: { id: enrollment.id }, data: { lastVerifiedAt: new Date() } });
    return done('MATCH', { studentId: student.id, score, live: true });
  }

  // ───────────────────────── compulsory enrolment (D-039) ─────────────────────────

  /** The notice for the current policy. Enrolment is only accepted against this exact version. */
  async notice() {
    const required = (await this.policy()).ENROLMENT_REQUIRED === true;
    const common = [
      'This is a prototype: it keeps a small encrypted numeric template of your face, never a photograph.',
      'Your template is used only at readers authorised for face verification, and every use is logged.',
      'Face verification does not change what you are allowed to access; the same rules apply as for your card.',
    ];
    return required
      ? {
        version: NOTICE_VERSION, required: true, title: 'Face enrolment is compulsory (prototype)',
        points: [
          'Face enrolment is compulsory for every student. You enrol once, in person, at the enrolment desk, before the date the university sets.',
          ...common,
          'You can see your enrolment and ask for your template to be deleted at any time (student portal, My face, or the desk). Deleting it means you must enrol again, unless you have an exemption.',
          'If you cannot or do not wish to use face verification (for example because of a disability, a safety concern or a conscientious objection), ask the enrolment desk for an exemption. You then keep using your card and QR code and nothing else changes.',
        ],
      }
      : {
        version: NOTICE_VERSION_VOLUNTARY, required: false, title: 'Optional face verification (prototype)',
        points: [
          'Face verification is optional. Your student card and rotating QR code always work without it.',
          ...common,
          'You can withdraw at any time in the student portal (My face) or at the enrolment desk. Your template is then deleted.',
        ],
      };
  }

  /** True when this student must be refused until they enrol (or are exempted): required, enforcement date reached, not enrolled, not exempt. */
  async enrolmentBlocked(studentId: string): Promise<boolean> {
    const p = await this.policy();
    if (p.ENROLMENT_REQUIRED !== true || typeof p.ENFORCE_FROM !== 'string') return false;
    if (new Date(`${p.ENFORCE_FROM}T00:00:00`).getTime() > Date.now()) return false;
    const [enrolled, ex] = await Promise.all([
      this.prisma.biometricEnrollment.count({ where: { studentId, status: { in: ['ACTIVE', 'SUSPENDED'] } } }),
      this.prisma.biometricExemption.findUnique({ where: { studentId } }),
    ]);
    return enrolled === 0 && !(ex && !ex.revokedAt);
  }

  /** Who still has to enrol: active students with no enrolment and no live exemption, plus the headline counts. */
  async pending(q: PageQuery) {
    const p = await this.policy();
    const base: Prisma.StudentWhereInput = { accountStatus: 'ACTIVE', deletedAt: null };
    const unenrolled: Prisma.StudentWhereInput = {
      ...base, biometricEnrollments: { none: { status: { in: ['ACTIVE', 'SUSPENDED'] } } },
      OR: [{ biometricExemption: null }, { biometricExemption: { revokedAt: { not: null } } }],
    };
    const [students, enrolled, exempt, total, rows] = await Promise.all([
      this.prisma.student.count({ where: base }),
      this.prisma.student.count({ where: { ...base, biometricEnrollments: { some: { status: { in: ['ACTIVE', 'SUSPENDED'] } } } } }),
      this.prisma.student.count({ where: { ...base, biometricExemption: { revokedAt: null } } }),
      this.prisma.student.count({ where: unenrolled }),
      this.prisma.student.findMany({ where: unenrolled, orderBy: { regNo: 'asc' }, skip: q.skip, take: q.pageSize, select: { regNo: true, fullName: true, programme: { select: { code: true } } } }),
    ]);
    const required = p.ENROLMENT_REQUIRED === true;
    const from = typeof p.ENFORCE_FROM === 'string' ? p.ENFORCE_FROM : null;
    return {
      summary: { required, enforceFrom: from, enforced: required && !!from && new Date(`${from}T00:00:00`).getTime() <= Date.now(), students, enrolled, exempt, pending: total },
      ...paged(rows.map((r) => ({ regNo: r.regNo, fullName: r.fullName, programme: r.programme.code })), total, q),
    };
  }

  async grantExemption(regNo: string, reason: string, actor: AuthUser, meta: RequestMeta) {
    const s = await this.prisma.student.findFirst({ where: { regNo, deletedAt: null } });
    if (!s) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    const cur = await this.prisma.biometricExemption.findUnique({ where: { studentId: s.id } });
    if (cur && !cur.revokedAt) throw new ConflictException({ code: 'ALREADY_EXEMPT', message: 'This student already has an exemption' });
    await this.prisma.$transaction(async (tx) => {
      await tx.biometricExemption.upsert({ where: { studentId: s.id }, update: { reason, grantedBy: actor.id, grantedAt: new Date(), revokedAt: null }, create: { studentId: s.id, reason, grantedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'biometrics.exemption_granted', entityType: 'Student', entityId: s.id, after: { regNo: s.regNo }, reason, requestMeta: meta }, tx);
      await tx.notification.create({ data: { studentId: s.id, kind: 'FACE_EXEMPTION', title: 'Face enrolment exemption', body: 'You are excused from face enrolment. Your card and QR code are your credentials.' } });
    });
    return { regNo: s.regNo, exempt: true };
  }

  async revokeExemption(regNo: string, reason: string, actor: AuthUser, meta: RequestMeta) {
    const s = await this.prisma.student.findFirst({ where: { regNo, deletedAt: null } });
    const cur = s ? await this.prisma.biometricExemption.findUnique({ where: { studentId: s.id } }) : null;
    if (!s || !cur || cur.revokedAt) throw new NotFoundException({ code: 'NO_EXEMPTION', message: 'This student has no exemption' });
    await this.prisma.$transaction(async (tx) => {
      await tx.biometricExemption.update({ where: { studentId: s.id }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId: actor.id, action: 'biometrics.exemption_revoked', entityType: 'Student', entityId: s.id, after: { regNo: s.regNo }, reason, requestMeta: meta }, tx);
    });
    return { regNo: s.regNo, exempt: false };
  }

  private failureMessage(f: string, detail: string) {
    if (f === 'QUALITY_FAILED') return `The image quality is too low (${detail}). Improve the lighting and face the camera.`;
    if (f === 'LIVENESS_FAILED') return `Liveness check failed (${detail}). Look at the camera and keep still but natural.`;
    return 'The capture could not be read. Please try again.';
  }
}
