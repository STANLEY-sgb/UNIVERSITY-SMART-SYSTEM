import { PrismaClient, CardStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { generateQrKeyPair, signQr } from '@kiu/vcard';
import { signReaderRequest } from '@kiu/security';
import { Harness, bearer, createStaff, loginBearer } from './harness';

const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase();

export interface ReaderCreds { keyId: string; secret: string; id: string; code: string }

/** Provisions a reader through the real admin API (as a Super Admin). */
export async function adminToken(h: Harness): Promise<string> {
  const u = await createStaff(h.prisma, ['SUPER_ADMIN']);
  const { token } = await loginBearer(h, u.email, u.password);
  await h.prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } }); // lifts MFA-setup gate on the live token
  return token!;
}

export async function provisionReader(h: Harness, token: string, serviceCode: string, venueCode: string): Promise<ReaderCreds> {
  const code = `T-${hex(4)}`;
  const res = await h.http().post('/api/v1/readers').set(bearer(token)).send({ code, name: `Test ${serviceCode}`, serviceCode, venueCode }).expect(201);
  return { id: res.body.reader.id, code, keyId: res.body.credentials.keyId, secret: res.body.credentials.secret };
}

export interface SignOpts { nonce?: string; timestamp?: string; secret?: string; keyId?: string; signBody?: string }

export function signedPost(h: Harness, creds: ReaderCreds, path: string, body: unknown, o: SignOpts = {}) {
  const url = `/api/v1${path}`;
  const payload = JSON.stringify(body);
  const ts = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomBytes(16).toString('hex');
  const sig = signReaderRequest(o.secret ?? creds.secret, 'POST', url, ts, nonce, o.signBody ?? payload);
  return h.http().post(url).set('Content-Type', 'application/json')
    .set('X-Reader-Key-Id', o.keyId ?? creds.keyId).set('X-Timestamp', ts).set('X-Nonce', nonce).set('X-Signature', sig).send(payload);
}

export const verify = (h: Harness, r: ReaderCreds, qr: string, extra: Record<string, unknown> = {}, o: SignOpts = {}) =>
  signedPost(h, r, '/access/verify', { credential: { type: 'QR', token: qr }, ...extra }, o);

export interface StudentSpec {
  active?: boolean; registered?: boolean; examCleared?: boolean; fees?: number; overdue?: number; fines?: number;
  meal?: boolean; hostelPaid?: boolean; enrol?: string[]; noStatus?: boolean;
}

export async function makeStudent(prisma: PrismaClient, s: StudentSpec = {}) {
  const prog = await prisma.programme.findFirstOrThrow({ where: { code: 'BCS' } });
  const sem = await prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
  const student = await prisma.student.create({
    data: { regNo: `TS-${hex(5)}`, fullName: 'Fictional Tester', programmeId: prog.id, yearOfStudy: 2, accountStatus: s.active === false ? 'SUSPENDED' : 'ACTIVE' },
  });
  if (!s.noStatus) {
    await prisma.studentStatus.create({
      data: {
        studentId: student.id, semesterId: sem.id, semesterRegistered: s.registered ?? true, examCleared: s.examCleared ?? true,
        feesPaidPercent: s.fees ?? 100, libraryOverdueItems: s.overdue ?? 0, libraryFinesUgx: s.fines ?? 0,
        mealPlanActive: s.meal ?? true, hostelFeesPaid: s.hostelPaid ?? true,
      },
    });
  }
  for (const code of s.enrol ?? []) {
    const cu = await prisma.courseUnit.findUniqueOrThrow({ where: { code } });
    await prisma.enrolment.create({ data: { studentId: student.id, courseUnitId: cu.id, semesterId: sem.id } });
  }
  return student;
}

export async function makeCard(prisma: PrismaClient, studentId: string, status: CardStatus = 'ACTIVE', opts: { expired?: boolean } = {}) {
  const keys = generateQrKeyPair();
  const cardNumber = `KIU${hex(6)}`;
  const card = await prisma.card.create({
    data: {
      cardNumber, uidHex: hex(7), studentId, status, regNoHash: hex(32),
      issuedAt: status === 'PENDING' ? null : new Date(),
      expiresAt: new Date(Date.now() + (opts.expired ? -86_400_000 : 365 * 86_400_000)),
    },
  });
  await prisma.cardCredential.create({ data: { cardId: card.id, kind: 'ED25519_QR', publicKeyHex: keys.publicKeyHex } });
  let counter = 0;
  return {
    card, keys, cardNumber,
    /** Fresh QR with a strictly increasing counter, like a real wallet. */
    qr: (o: { counter?: number; nowSeconds?: number; keyHex?: string } = {}) =>
      signQr(o.keyHex ?? keys.privateKeyHex, { cardNumber, counter: o.counter ?? ++counter, ...(o.nowSeconds !== undefined ? { nowSeconds: o.nowSeconds } : {}) }),
  };
}

/** Exam with an entry window around "now" (or already closed). */
export async function makeExam(prisma: PrismaClient, venueCode: string, opts: { open?: boolean } = {}) {
  const sem = await prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
  const venue = await prisma.venue.findUniqueOrThrow({ where: { code: venueCode } });
  const dept = await prisma.department.findFirstOrThrow({ where: { code: 'CS' } });
  const cu = await prisma.courseUnit.create({ data: { code: `EX${hex(3)}`, title: 'Exam fixture', departmentId: dept.id } });
  const h = 3_600_000, now = Date.now(), open = opts.open ?? true;
  const exam = await prisma.examSession.create({
    data: {
      courseUnitId: cu.id, semesterId: sem.id, venueId: venue.id,
      startsAt: new Date(now + (open ? 0 : -5 * h)), endsAt: new Date(now + (open ? 3 * h : -2 * h)),
      entryOpensAt: new Date(now + (open ? -h : -6 * h)), entryClosesAt: new Date(now + (open ? h : -4 * h)),
    },
  });
  return { exam, courseCode: cu.code };
}

// ───────────────── Phase 4 helpers: simulator transport + student accounts ─────────────────
import * as argon2 from 'argon2';
import type { ApiTransport } from '@kiu/simulator';
import { ApiClient } from '@kiu/simulator';
import { TEST_PASSWORD } from './harness';

/** Routes the simulator's HTTP calls into the in-process Nest app, so tests use the real API surface. */
export function supertestTransport(h: Harness): ApiTransport {
  return {
    async request(method, path, opts = {}) {
      let req = (h.http() as any)[method.toLowerCase()](path) as import('supertest').Test;
      for (const [k, v] of Object.entries(opts.headers ?? {})) req = req.set(k, v);
      if (opts.bodyText !== undefined) req = req.send(opts.bodyText);
      const res = await req;
      return { status: res.status, body: res.body };
    },
  };
}
export const apiFor = (h: Harness) => new ApiClient(supertestTransport(h));

/** A student with a login, returned with a bearer token. */
export async function makeStudentUser(h: Harness, spec: StudentSpec = {}) {
  const student = await makeStudent(h.prisma, spec);
  const role = await h.prisma.role.findUniqueOrThrow({ where: { code: 'STUDENT' } });
  const email = `stu.${hex(5).toLowerCase()}@test.invalid`;
  await h.prisma.user.create({
    data: {
      email, displayName: student.fullName, userType: 'STUDENT', studentId: student.id,
      passwordHash: await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 }),
      roles: { create: [{ roleId: role.id }] },
    },
  });
  const token = await apiFor(h).login(email, TEST_PASSWORD);
  return { student, email, password: TEST_PASSWORD, token };
}

export async function staffToken(h: Harness, role: string): Promise<string> {
  const u = await createStaff(h.prisma, [role]);
  return apiFor(h).login(u.email, u.password);
}

/** Makes one meal sitting (BREAKFAST) cover the whole day so cafeteria tests do not depend on the wall clock. */
export async function openMealsAllDay(prisma: PrismaClient) {
  await prisma.mealSitting.updateMany({ where: { mealType: 'BREAKFAST' }, data: { startsAt: '00:00', endsAt: '23:59' } });
}

/** A lecture in `venueCode` that is live right now (server-local clock), for the given course unit. */
export async function makeLiveLecture(prisma: PrismaClient, venueCode: string, courseCode: string) {
  const venue = await prisma.venue.findUniqueOrThrow({ where: { code: venueCode } });
  const cu = await prisma.courseUnit.findUniqueOrThrow({ where: { code: courseCode } });
  await clearLectures(prisma, venue.id);
  return prisma.lectureSchedule.create({ data: { courseUnitId: cu.id, venueId: venue.id, dayOfWeek: new Date().getDay(), startsAt: '00:00', endsAt: '23:59' } });
}

/** Removes a room's timetable (and the attendance that depends on it) so a test controls what is "live". */
export async function clearLectures(prisma: PrismaClient, venueId: string) {
  await prisma.lectureAttendance.deleteMany({ where: { schedule: { venueId } } });
  await prisma.lectureSchedule.deleteMany({ where: { venueId } });
}
