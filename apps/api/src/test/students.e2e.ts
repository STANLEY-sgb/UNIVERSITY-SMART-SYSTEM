import { PrismaClient } from '@prisma/client';
import { SERVICE_CODES } from '@kiu/shared';
import { Harness, bearer, createStaff, loginBearer, startHarness } from './harness';
import { seedCore } from '../seed/core';
import { seedDemo } from '../seed/demo';

describe('students + demo register (e2e)', () => {
  let h: Harness;
  let registryToken: string;
  let programmeId: string;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 60 });
    programmeId = (await h.prisma.programme.findFirstOrThrow({ where: { code: 'BCS' } })).id;
    const registry = await createStaff(h.prisma, ['REGISTRY_OFFICER']);
    registryToken = (await loginBearer(h, registry.email, registry.password)).token!;
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it('seeds a varied fictional register of 50+ students', async () => {
    const total = await h.prisma.student.count();
    expect(total).toBeGreaterThanOrEqual(50);
    expect(await h.prisma.student.count({ where: { isFictional: false } })).toBe(0);

    const facts = await h.prisma.studentStatus.findMany();
    const has = (pred: (f: (typeof facts)[number]) => boolean) => facts.some(pred);
    expect(has((f) => Number(f.feesPaidPercent) < 100)).toBe(true);          // outstanding finance
    expect(has((f) => f.examCleared)).toBe(true);                             // fully cleared
    expect(has((f) => !f.semesterRegistered)).toBe(true);                     // unregistered
    expect(has((f) => f.libraryOverdueItems > 0)).toBe(true);                 // overdue items
    expect(has((f) => f.libraryFinesUgx > 0)).toBe(true);                     // fines
    expect(has((f) => f.mealPlanActive)).toBe(true);
    expect(has((f) => !f.mealPlanActive)).toBe(true);
    expect(await h.prisma.hostelAllocation.count()).toBeGreaterThan(0);
    expect(await h.prisma.student.count({ where: { accountStatus: 'SUSPENDED' } })).toBeGreaterThan(0);
    expect(await h.prisma.enrolment.count()).toBeGreaterThan(50);
    const serviceCodes = (await h.prisma.service.findMany()).map((s) => s.code);
    expect(serviceCodes).toEqual(expect.arrayContaining([...SERVICE_CODES]));
    expect(await h.prisma.examSession.count()).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent: re-seeding does not duplicate data', async () => {
    const before = { s: await h.prisma.student.count(), u: await h.prisma.user.count(), r: await h.prisma.role.count() };
    const p = new PrismaClient();
    try { await seedCore(p); await seedDemo(p, { students: 60 }); } finally { await p.$disconnect(); }
    expect({ s: await h.prisma.student.count(), u: await h.prisma.user.count(), r: await h.prisma.role.count() }).toEqual(before);
  }, 120_000);

  it('seeds a demo account for every staff role, and each can sign in (admins need MFA setup first)', async () => {
    for (const code of ['SECURITY_OFFICER', 'INVIGILATOR', 'LIBRARIAN', 'FINANCE_OFFICER', 'CARD_OFFICER', 'SUPER_ADMIN']) {
      const email = `${code.toLowerCase().replace(/_/g, '-')}@kiu-demo.test`;
      const { res } = await loginBearer(h, email, 'Demo-Password-2026!');
      expect([code, res.status]).toEqual([code, 200]);
      expect(res.body.mfaSetupRequired).toBe(code === 'SUPER_ADMIN');
    }
    const student = await loginBearer(h, 'student01@kiu-demo.test', 'Demo-Password-2026!');
    expect(student.res.body.user.roles).toEqual(['STUDENT']);
  });

  describe('API', () => {
    it('lists with pagination, search and filters', async () => {
      const page = await h.http().get('/api/v1/students?pageSize=10&page=2').set(bearer(registryToken)).expect(200);
      expect(page.body.data).toHaveLength(10);
      expect(page.body.meta).toMatchObject({ page: 2, pageSize: 10 });
      expect(page.body.meta.total).toBeGreaterThanOrEqual(50);

      const one = await h.http().get('/api/v1/students?q=2026-BCS-0001').set(bearer(registryToken)).expect(200);
      expect(one.body.data.map((s: { regNo: string }) => s.regNo)).toContain('2026-BCS-0001');

      const suspended = await h.http().get('/api/v1/students?accountStatus=SUSPENDED').set(bearer(registryToken)).expect(200);
      expect(suspended.body.data.length).toBeGreaterThan(0);
      expect(suspended.body.data.every((s: { accountStatus: string }) => s.accountStatus === 'SUSPENDED')).toBe(true);

      await h.http().get('/api/v1/students?pageSize=1000').set(bearer(registryToken)).expect(400);
    });

    it('shapes responses safely (no photo hashes or internal flags)', async () => {
      const list = await h.http().get('/api/v1/students?pageSize=1').set(bearer(registryToken)).expect(200);
      expect(Object.keys(list.body.data[0]).sort()).toEqual(
        ['accountStatus', 'cards', 'createdAt', 'email', 'fullName', 'id', 'phone', 'programme', 'regNo', 'yearOfStudy'].sort(),
      );
    });

    it('creates a student (fail-closed facts), audits it, and rejects duplicates', async () => {
      const regNo = `2030-BCS-${Date.now().toString().slice(-6)}`;
      const body = { regNo, fullName: 'Test New Student', programmeId, yearOfStudy: 1 };
      const created = await h.http().post('/api/v1/students').set(bearer(registryToken)).send(body).expect(201);
      expect(created.body.regNo).toBe(regNo.toUpperCase());

      const facts = await h.prisma.studentStatus.findFirstOrThrow({ where: { studentId: created.body.id } });
      expect(facts).toMatchObject({ semesterRegistered: false, examCleared: false, hostelFeesPaid: false, mealPlanActive: false });
      expect(Number(facts.feesPaidPercent)).toBe(0);

      expect(await h.prisma.auditTrail.count({ where: { action: 'students.create', entityId: created.body.id } })).toBe(1);
      await h.http().post('/api/v1/students').set(bearer(registryToken)).send(body).expect(409);
      await h.http().post('/api/v1/students').set(bearer(registryToken)).send({ ...body, regNo: 'bad reg!' }).expect(400);
      await h.http().post('/api/v1/students').set(bearer(registryToken)).send({ ...body, regNo: 'OK-12345', programmeId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    });

    it('changes account status only with a reason, and records before/after', async () => {
      const regNo = `2030-LLB-${Date.now().toString().slice(-6)}`;
      const created = await h.http().post('/api/v1/students').set(bearer(registryToken)).send({ regNo, fullName: 'Status Test', programmeId, yearOfStudy: 2 }).expect(201);
      await h.http().patch(`/api/v1/students/${regNo}/status`).set(bearer(registryToken)).send({ accountStatus: 'SUSPENDED' }).expect(400);
      const res = await h.http().patch(`/api/v1/students/${regNo}/status`).set(bearer(registryToken)).send({ accountStatus: 'SUSPENDED', reason: 'Disciplinary hearing pending' }).expect(200);
      expect(res.body.accountStatus).toBe('SUSPENDED');
      const entry = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'students.status_change', entityId: created.body.id } });
      expect(entry.before).toEqual({ accountStatus: 'ACTIVE' });
      expect(entry.after).toEqual({ accountStatus: 'SUSPENDED' });
      expect(entry.reason).toBe('Disciplinary hearing pending');
      await h.http().patch('/api/v1/students/NO-SUCH-REG/status').set(bearer(registryToken)).send({ accountStatus: 'ACTIVE', reason: 'no such student' }).expect(404);
    });

    it('returns 404 for unknown ids and 400 for malformed ones', async () => {
      await h.http().get('/api/v1/students/00000000-0000-4000-8000-000000000000').set(bearer(registryToken)).expect(404);
      await h.http().get('/api/v1/students/not-a-uuid').set(bearer(registryToken)).expect(400);
    });
  });
});
