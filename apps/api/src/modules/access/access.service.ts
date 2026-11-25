import { Inject, Injectable } from '@nestjs/common';
import { AuthMethod, Decision, Direction, Prisma } from '@prisma/client';
import { RuleDefinition, evaluate, validateRule } from '@kiu/rules-engine';
import { REASON_CODES, ReasonCode } from '@kiu/shared';
import { checkQrTime, decryptCardRead, deriveCardKey, parseQr, verifyQrSignature } from '@kiu/vcard';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { ReaderContext } from '../readers/reader-auth.guard';
import { EventsService } from '../events/events.module';
import { BiometricsService } from '../biometrics/biometrics.service';
import { FactsService } from './facts.service';
import { Prep, WorkflowsService } from './workflows.service';

export type CredentialInput =
  | { type: 'QR'; token: string }
  | { type: 'TAP'; sessionId: string; ivHex: string; ctHex: string; macHex: string }
  | { type: 'FACE'; regNo: string; frames: unknown };

export interface VerifyInput {
  service?: string | undefined;
  credential: CredentialInput;
  direction?: 'ENTRY' | 'EXIT' | undefined;
  context?: { examSessionId?: string | undefined; courseUnitCode?: string | undefined } | undefined;
  requestNonce?: string | undefined;
}

export interface VerifyResult {
  decision: Decision;
  reason_code: ReasonCode | string;
  message: string;
  student: { reg_no: string; full_name: string; programme: string; photo_ref: string | null } | null;
  log_id: string;
  decided_at: string;
  processing_ms: number;
}

interface Outcome {
  decision: Decision;
  reason: string;
  message: string;
  studentId?: string;
  cardId?: string;
  ruleVersionId?: string;
  showStudent?: boolean;
  context?: Record<string, unknown>;
  after?: (tx: Prisma.TransactionClient, logId: string) => Promise<void>;
}

const deny = (reason: string, message: string, extra: Partial<Outcome> = {}): Outcome => ({ decision: 'DENY', reason, message, ...extra });

type CardWithStudent = Prisma.CardGetPayload<{ include: { credentials: true; student: { include: { programme: true } } } }>;
/** What every credential type must produce before the shared pipeline runs. */
type Authenticated = { card: CardWithStudent; counter: number; credentialRevoked: boolean };

@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: FactsService,
    private readonly alerts: AlertsService,
    private readonly workflows: WorkflowsService,
    private readonly biometrics: BiometricsService,
    private readonly events: EventsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * The single decision entry point. Fail-closed: any unexpected error becomes a logged DENY,
   * never a grant. Reader authentication already happened in ReaderAuthGuard.
   */
  async verify(reader: ReaderContext, input: VerifyInput): Promise<VerifyResult> {
    const started = performance.now();
    let outcome: Outcome;
    try {
      outcome = await this.decide(reader, input);
    } catch (e) {
      outcome = deny(REASON_CODES.SYSTEM_ERROR, 'The system could not complete this check. Access denied.', { context: { error: (e as Error).name } });
    }
    return this.finish(reader, input, outcome, started);
  }

  // ───────────────────────── credential authentication (per type) ─────────────────────────

  private async authenticateQr(reader: ReaderContext, token: string): Promise<Authenticated | { deny: Outcome }> {
    const parsed = parseQr(token);
    if (!parsed.ok) return { deny: deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential not recognised.', { context: { parse: parsed.error } }) };

    const card = await this.prisma.card.findUnique({
      where: { cardNumber: parsed.payload.cn },
      include: { credentials: true, student: { include: { programme: true } } },
    });
    if (!card) return { deny: deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential not recognised.') };

    // Check against every QR key the card ever had, so a revoked (lost) credential is recognised as such.
    const qrCreds = card.credentials.filter((c) => c.kind === 'ED25519_QR');
    const matched = qrCreds.find((c) => c.publicKeyHex && verifyQrSignature(parsed, c.publicKeyHex));
    if (!matched) {
      await this.alerts.raise({ kind: 'BAD_SIGNATURE', severity: 'MEDIUM', readerId: reader.id, cardId: card.id, studentId: card.studentId });
      return { deny: deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential could not be verified.', { cardId: card.id }) };
    }

    const timeError = checkQrTime(parsed.payload);
    if (timeError === 'EXPIRED') return { deny: deny(REASON_CODES.CREDENTIAL_EXPIRED, 'QR code has expired. Ask the student to refresh it.', { cardId: card.id, studentId: card.studentId }) };
    if (timeError) return { deny: deny(REASON_CODES.CREDENTIAL_INVALID, 'Credential is not valid at this time.', { cardId: card.id }) };

    // A given QR nonce can be spent exactly once.
    try {
      await this.prisma.credentialNonce.create({
        data: { nonce: `qr:${card.cardNumber}:${parsed.payload.n}`, scope: 'QR', expiresAt: new Date((parsed.payload.exp + 120) * 1000) },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      await this.alerts.raise({ kind: 'QR_REPLAY', severity: 'HIGH', readerId: reader.id, cardId: card.id, studentId: card.studentId });
      return { deny: deny(REASON_CODES.NONCE_REPLAY, 'This QR code was already used.', { cardId: card.id, studentId: card.studentId }) };
    }
    return { card, counter: parsed.payload.ctr, credentialRevoked: matched.status === 'REVOKED' };
  }

  private async authenticateTap(reader: ReaderContext, c: Extract<CredentialInput, { type: 'TAP' }>): Promise<Authenticated | { deny: Outcome }> {
    const invalid = (msg = 'Card could not be authenticated.', extra: Partial<Outcome> = {}) => ({ deny: deny(REASON_CODES.CREDENTIAL_INVALID, msg, extra) });
    const session = await this.prisma.tapSession.findUnique({ where: { id: c.sessionId } }).catch(() => null);
    if (!session || session.readerId !== reader.id || !session.cardId || !session.rndC || session.expiresAt < new Date()) return invalid();

    // One authenticated session = one read. Spending it atomically defeats double-submission.
    const spent = await this.prisma.tapSession.updateMany({ where: { id: session.id, state: 'AUTHENTICATED' }, data: { state: 'USED' } });
    if (spent.count !== 1) {
      await this.alerts.raise({ kind: 'TAP_SESSION_REPLAY', severity: 'HIGH', readerId: reader.id, cardId: session.cardId });
      return { deny: deny(REASON_CODES.NONCE_REPLAY, 'This card read was already used.', { cardId: session.cardId }) };
    }

    const card = await this.prisma.card.findUnique({ where: { id: session.cardId }, include: { credentials: true, student: { include: { programme: true } } } });
    if (!card) return invalid();
    const kc = deriveCardKey(this.env.CARD_MASTER_KEY, card.uidHex, card.aidHex);
    const read = decryptCardRead(kc, Buffer.from(session.rndR, 'hex'), Buffer.from(session.rndC, 'hex'), { ivHex: c.ivHex, ctHex: c.ctHex, macHex: c.macHex });
    if (!read.ok || read.cardNumber !== card.cardNumber) {
      await this.alerts.raise({ kind: 'TAP_BAD_READ', severity: 'MEDIUM', readerId: reader.id, cardId: card.id, studentId: card.studentId, detail: { error: read.ok ? 'CARD_NUMBER_MISMATCH' : read.error } });
      return invalid('Card read could not be verified.', { cardId: card.id });
    }
    const aes = card.credentials.filter((x) => x.kind === 'AES_CARD_KEY');
    return { card, counter: read.counter, credentialRevoked: aes.length > 0 && aes.every((x) => x.status === 'REVOKED') };
  }

  /**
   * Face is an independent credential (docs/ARCHITECTURE.md section 7): it resolves a student through a 1:1 match against
   * the claimed registration number, and a lost or blocked CARD does not by itself stop it. Everything after identity
   * (account status, rules, anti-passback, meal claims) is the shared pipeline below.
   */
  private async authenticateFace(reader: ReaderContext, c: Extract<CredentialInput, { type: 'FACE' }>): Promise<{ studentId: string } | { deny: Outcome }> {
    const r = await this.biometrics.verifyOneToOne(reader, c.regNo, c.frames);
    const faceContext = { face: { outcome: r.outcome, score: r.score ?? null, latencyMs: r.latencyMs } };
    if (r.outcome === 'MATCH') return { studentId: r.studentId };
    const table: Record<string, [string, string]> = {
      NO_MATCH: [REASON_CODES.FACE_NO_MATCH, 'The face did not match. Try again or use your card or QR code.'],
      LIVENESS_FAILED: [REASON_CODES.FACE_LIVENESS_FAILED, 'Liveness check failed. Look at the camera, or use your card or QR code.'],
      QUALITY_FAILED: [REASON_CODES.FACE_QUALITY_FAILED, 'The image was not clear enough. Improve the lighting and try again.'],
      NOT_ENROLLED: [REASON_CODES.FACE_NOT_ENROLLED, 'Face verification is not set up for this student. Use your card or QR code.'],
      CONSENT_REVOKED: [REASON_CODES.FACE_CONSENT_REVOKED, 'Face verification is switched off for this student. Use your card or QR code.'],
      AMBIGUOUS: [REASON_CODES.FACE_AMBIGUOUS, 'The face could not be told apart. Use your card or QR code.'],
      ERROR: r.detail === 'FACE_NOT_ENABLED' ? [REASON_CODES.FACE_NOT_ENABLED, 'Face verification is not enabled at this reader. Use your card or QR code.']
        : r.detail === 'FACE_LOCKED' ? [REASON_CODES.FACE_LOCKED, 'Too many failed face checks. Face is paused for a few minutes; use your card or QR code.']
        : [REASON_CODES.FACE_ASSERTION_INVALID, 'The face check could not be completed. Use your card or QR code.'],
    };
    const [reason, message] = table[r.outcome] ?? table.ERROR!;
    return { deny: deny(reason, message, { context: faceContext }) };
  }

  // ───────────────────────── shared pipeline ─────────────────────────

  private async decide(reader: ReaderContext, input: VerifyInput): Promise<Outcome> {
    if (input.service && input.service.toUpperCase() !== reader.serviceCode) {
      await this.alerts.raise({ kind: 'READER_SERVICE_MISMATCH', severity: 'MEDIUM', readerId: reader.id, detail: { claimed: input.service, assigned: reader.serviceCode } });
      return deny(REASON_CODES.READER_SERVICE_MISMATCH, 'This reader is not assigned to that service.');
    }

    // ── 1-3. Credential authenticity -> a student, never a student id supplied by the client ──
    let student: { id: string; accountStatus: string };
    let ids: { cardId?: string; studentId: string };
    let card: CardWithStudent | null = null;
    if (input.credential.type === 'FACE') {
      const f = await this.authenticateFace(reader, input.credential);
      if ('deny' in f) return f.deny;
      const s = await this.prisma.student.findUniqueOrThrow({ where: { id: f.studentId }, select: { id: true, accountStatus: true } });
      student = s; ids = { studentId: s.id };
      if (student.accountStatus !== 'ACTIVE') return deny(REASON_CODES.STUDENT_SUSPENDED, 'Student account is not active.', ids);
    } else {
      // ── 1. Credential authenticity (QR or TAP) -> a card, never a student id supplied by the client ──
      const auth = input.credential.type === 'QR'
        ? await this.authenticateQr(reader, input.credential.token)
        : await this.authenticateTap(reader, input.credential);
      if ('deny' in auth) return auth.deny;
      card = auth.card; const { counter, credentialRevoked } = auth;

      // ── 2. Card lifecycle (authenticity already proven, so status is trustworthy) ──
      ids = { cardId: card.id, studentId: card.studentId };
      if (card.status === 'LOST' || credentialRevoked) {
        await this.alerts.raise({ kind: 'LOST_CARD_PRESENTED', severity: 'HIGH', readerId: reader.id, ...ids });
        return deny(REASON_CODES.CARD_LOST, 'This card has been reported lost and is no longer valid.', ids);
      }
      if (card.status === 'BLOCKED') {
        await this.alerts.raise({ kind: 'BLOCKED_CARD_PRESENTED', severity: 'MEDIUM', readerId: reader.id, ...ids });
        return deny(REASON_CODES.CARD_BLOCKED, 'This card is blocked. Contact the card office.', ids);
      }
      if (card.status === 'EXPIRED' || card.expiresAt < new Date()) return deny(REASON_CODES.CARD_EXPIRED, 'This card has expired.', ids);
      if (card.status !== 'ACTIVE') return deny(REASON_CODES.CARD_UNKNOWN, 'This card is not active.', ids);

      // Counter must strictly increase; an old/duplicated counter indicates a copied credential.
      const advanced = await this.prisma.card.updateMany({ where: { id: card.id, txCounter: { lt: BigInt(counter) } }, data: { txCounter: BigInt(counter) } });
      if (advanced.count !== 1) {
        await this.alerts.raise({ kind: 'COUNTER_REGRESSION', severity: 'HIGH', readerId: reader.id, ...ids });
        return deny(REASON_CODES.COUNTER_INVALID, 'Credential counter is invalid.', ids);
      }

      // ── 3. Student account ──
      student = card.student;
      if (student.accountStatus !== 'ACTIVE') return deny(REASON_CODES.STUDENT_SUSPENDED, 'Student account is not active.', ids);

      // ── 3b. Compulsory face enrolment (D-039): once the university's enforcement date has passed, every credential is refused until enrolled or exempt ──
      if (await this.biometrics.enrolmentBlocked(student.id)) return deny(REASON_CODES.FACE_ENROLMENT_REQUIRED, 'Face enrolment is required. Please visit the enrolment desk (or ask for an exemption).', ids);

    }

    // ── 4. Published rule ──
    const rule = await this.prisma.accessRule.findFirst({ where: { service: { code: reader.serviceCode } }, include: { published: true } });
    if (!rule?.published) return deny(REASON_CODES.RULE_MISSING, 'No access rule is published for this service.', { ...ids, showStudent: true });
    const parsedRule = validateRule(rule.published.definition);
    if (!parsedRule.ok) return deny(REASON_CODES.RULE_MISSING, 'The access rule for this service is invalid.', { ...ids, ruleVersionId: rule.published.id });
    const definition: RuleDefinition = parsedRule.definition!;

    // ── 5. Facts + context, then evaluation (identical for every credential type) ──
    const now = new Date();
    const facts = await this.facts.loadFacts(student.id, card?.status ?? null);
    const context: Record<string, unknown> = {
      ...(await this.facts.baseContext(now)),
      service: reader.serviceCode, reader_code: reader.code, venue_code: reader.venueCode, direction: input.direction ?? 'NONE',
    };

    let examSessionId: string | null = null;
    if (reader.serviceCode === 'EXAM') {
      const exam = await this.resolveExam(student.id, reader, input, now, facts);
      if (!exam) return deny(REASON_CODES.OUTSIDE_TIME_WINDOW, 'No examination is scheduled for this student at this time.', { ...ids, ruleVersionId: rule.published.id, showStudent: true });
      examSessionId = exam.id;
      Object.assign(context, exam.context);
    }

    // Service-specific context (lecture timetable, hostel, meal sitting) or a precise denial when none applies.
    let prep: Prep = { context: {} };
    if (reader.serviceCode !== 'EXAM') {
      prep = await this.workflows.prepare(reader, input.context, now);
      if (prep.denial) return deny(prep.denial.reason, prep.denial.message, { ...ids, ruleVersionId: rule.published.id, showStudent: true });
      Object.assign(context, prep.context);
    }

    const result = evaluate(definition, facts, context);
    const base = { ...ids, ruleVersionId: rule.published.id, showStudent: true, context: { failedFact: result.failure?.fact ?? null } };
    if (!result.allowed) {
      const f = result.failure!;
      return { ...base, decision: 'DENY', reason: f.reason, message: f.message };
    }

    // ── 6. Exclusive claims (anti-passback, one meal per sitting): atomic, only after the rules said yes ──
    const claimed = await this.workflows.claim(reader, student.id, input.direction, now, prep);
    if (claimed) return { ...base, decision: 'DENY', reason: claimed.reason, message: claimed.message };

    // ── 7. GRANT side effects, in the same transaction as the log ──
    const seat = examSessionId ? (await this.prisma.examSeat.findUnique({ where: { examSessionId_studentId: { examSessionId, studentId: student.id } }, select: { seatLabel: true } }))?.seatLabel : undefined;
    return {
      ...base, decision: 'GRANT', reason: REASON_CODES.OK, message: seat ? `Access granted. Your seat is ${seat}.` : 'Access granted.',
      after: async (tx: Prisma.TransactionClient, logId: string) => {
        if (examSessionId) {
          // Unique (exam_session_id, student_id): duplicates are impossible whatever route recorded them.
          await tx.examAttendance.upsert({
            where: { examSessionId_studentId: { examSessionId, studentId: student.id } },
            update: {}, create: { examSessionId, studentId: student.id, accessLogId: logId },
          });
        }
        await this.workflows.finalize(tx, logId, student.id, prep);
      },
    };
  }

  /** Finds the examination this student is attempting: their own enrolled exam first, else the one at this venue. */
  private async resolveExam(studentId: string, reader: ReaderContext, input: VerifyInput, now: Date, facts: Record<string, unknown>) {
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    if (!semester) return null;
    const include = { courseUnit: true, venue: true } as const;
    let exam = input.context?.examSessionId
      ? await this.prisma.examSession.findFirst({ where: { id: input.context.examSessionId, semesterId: semester.id }, include })
      : null;
    if (!exam) {
      const open = { semesterId: semester.id, entryOpensAt: { lte: now }, entryClosesAt: { gte: now } };
      const mine = (facts.enrolled_course_units as string[] | undefined) ?? [];
      const day = 86_400_000;
      // Prefer the student's OWN paper so that denials talk about it (wrong room / too early / closed),
      // and only fall back to whatever is running in this hall (=> "not enrolled").
      exam = await this.prisma.examSession.findFirst({ where: { ...open, courseUnit: { code: { in: mine } } }, include, orderBy: { startsAt: 'asc' } })
        ?? await this.prisma.examSession.findFirst({
          where: { semesterId: semester.id, courseUnit: { code: { in: mine } }, startsAt: { gte: new Date(now.getTime() - day), lte: new Date(now.getTime() + day) } },
          include, orderBy: { startsAt: 'asc' },
        })
        ?? await this.prisma.examSession.findFirst({ where: { ...open, venueId: reader.venueId }, include, orderBy: { startsAt: 'asc' } });
    }
    if (!exam) return null;
    return {
      id: exam.id,
      context: {
        course_unit: exam.courseUnit.code, exam_venue_code: exam.venue.code,
        window_start: exam.entryOpensAt.toISOString(), window_end: exam.entryClosesAt.toISOString(),
      },
    };
  }

  private async finish(reader: ReaderContext, input: VerifyInput, o: Outcome, started: number): Promise<VerifyResult> {
    const processingMs = Math.round(performance.now() - started);
    const direction = (input.direction ?? 'NONE') as Direction;
    const authMethod: AuthMethod = input.credential.type === 'TAP' ? 'VIRTUAL_TAP' : input.credential.type === 'FACE' ? 'FACE' : 'QR';
    const log = await this.prisma.$transaction(async (tx) => {
      const row = await tx.accessLog.create({
        data: {
          readerId: reader.id, serviceId: reader.serviceId, venueId: reader.venueId,
          studentId: o.studentId ?? null, cardId: o.cardId ?? null, ruleVersionId: o.ruleVersionId ?? null,
          authMethod, direction, decision: o.decision, reasonCode: o.reason, message: o.message,
          processingMs, requestNonce: input.requestNonce ?? null, context: (o.context ?? {}) as Prisma.InputJsonValue,
        },
      });
      if (o.decision === 'GRANT' && o.after) await o.after(tx, row.id);
      return row;
    });

    this.events.publish({ type: 'decision', decision: o.decision, service: reader.serviceCode, offline: false, at: log.occurredAt.toISOString() });

    let student: VerifyResult['student'] = null;
    if (o.showStudent && o.studentId && reader.serviceCode !== 'HEALTH') {
      const s = await this.prisma.student.findUnique({ where: { id: o.studentId }, include: { programme: true } });
      if (s) student = { reg_no: s.regNo, full_name: s.fullName, programme: s.programme.code, photo_ref: s.photoRef };
    }
    return {
      decision: o.decision, reason_code: o.reason, message: o.message, student, log_id: log.id,
      decided_at: log.occurredAt.toISOString(), processing_ms: processingMs,
    };
  }
}
