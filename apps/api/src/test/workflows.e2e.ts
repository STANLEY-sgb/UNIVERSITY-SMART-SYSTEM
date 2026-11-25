import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { ReaderCreds, adminToken, makeCard, makeExam, makeLiveLecture, makeStudent, openMealsAllDay, provisionReader, staffToken, verify } from './access-fixtures';

describe('university service workflows (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let gate: ReaderCreds, cafe: ReaderCreds, lecture: ReaderCreds, hostel: ReaderCreds, exam: ReaderCreds, borrow: ReaderCreds;
  let finance: string, registry: string, librarian: string, cardOfficer: string;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    await openMealsAllDay(h.prisma);
    const admin = await adminToken(h);
    gate = await provisionReader(h, admin, 'GATE', 'GATE-MAIN');
    cafe = await provisionReader(h, admin, 'CAFETERIA', 'CAF-MAIN');
    lecture = await provisionReader(h, admin, 'LECTURE', 'LH-1');
    hostel = await provisionReader(h, admin, 'HOSTEL', 'HOSTEL-A');
    exam = await provisionReader(h, admin, 'EXAM', 'EXH-A');
    borrow = await provisionReader(h, admin, 'LIBRARY_BORROW', 'LIB-MAIN');
    finance = await staffToken(h, 'FINANCE_OFFICER');
    registry = await staffToken(h, 'REGISTRY_OFFICER');
    librarian = await staffToken(h, 'LIBRARIAN');
    cardOfficer = await staffToken(h, 'CARD_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const scan = async (r: ReaderCreds, c: Awaited<ReturnType<typeof makeCard>>, extra: Record<string, unknown> = {}) =>
    (await verify(h, r, c.qr(), extra).expect(200)).body;

  describe('gate anti-passback (TC-06)', () => {
    it('refuses a second ENTRY until an EXIT is recorded', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect(await scan(gate, c, { direction: 'ENTRY' })).toMatchObject({ decision: 'GRANT' });
      expect(await scan(gate, c, { direction: 'ENTRY' })).toMatchObject({ decision: 'DENY', reason_code: 'ANTI_PASSBACK' });
      expect(await scan(gate, c, { direction: 'EXIT' })).toMatchObject({ decision: 'GRANT' });
      expect(await scan(gate, c, { direction: 'ENTRY' })).toMatchObject({ decision: 'GRANT' });
    });

    it('an EXIT with no prior ENTRY is allowed (a card may be tapped out after a reader outage)', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect(await scan(gate, c, { direction: 'EXIT' })).toMatchObject({ decision: 'GRANT' });
    });

    it('a denied scan does not change presence', async () => {
      const s = await makeStudent(h.prisma, { active: false });
      const c = await makeCard(h.prisma, s.id);
      expect((await scan(gate, c, { direction: 'ENTRY' })).decision).toBe('DENY');
      expect(await h.prisma.presenceState.count({ where: { studentId: s.id } })).toBe(0);
    });

    it('simultaneous ENTRY scans: exactly one wins (counter and claim defences)', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const qrs = Array.from({ length: 6 }, () => c.qr());
      const res = await Promise.all(qrs.map((q) => verify(h, gate, q, { direction: 'ENTRY' })));
      const decisions = res.map((r) => r.body.decision);
      expect(decisions.filter((d) => d === 'GRANT')).toHaveLength(1);
    });

    it('a missing direction is allowed by default and refused when the policy requires one', async () => {
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      expect((await scan(gate, c)).decision).toBe('GRANT');
      const before = await h.prisma.systemSetting.findUnique({ where: { key: 'policy' } });
      await h.prisma.systemSetting.update({ where: { key: 'policy' }, data: { value: { ...(before!.value as object), gate_direction_required: true } } });
      try {
        expect(await scan(gate, c)).toMatchObject({ decision: 'DENY', reason_code: 'DIRECTION_REQUIRED' });
      } finally {
        await h.prisma.systemSetting.update({ where: { key: 'policy' }, data: { value: before!.value as object } });
      }
    });
  });

  describe('cafeteria: one meal per sitting (demo 5)', () => {
    it('serves once, then refuses a repeat even with a different credential session', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id);
      expect(await scan(cafe, c)).toMatchObject({ decision: 'GRANT' });
      expect(await scan(cafe, c)).toMatchObject({ decision: 'DENY', reason_code: 'MEAL_ALREADY_CLAIMED' });
      expect(await h.prisma.mealUsage.count({ where: { studentId: s.id } })).toBe(1);
      const usage = await h.prisma.mealUsage.findFirstOrThrow({ where: { studentId: s.id } });
      expect(usage.accessLogId).toBeTruthy();
    });

    it('simultaneous scans produce exactly one meal', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id);
      const res = await Promise.all(Array.from({ length: 6 }, () => verify(h, cafe, c.qr())));
      expect(res.filter((r) => r.body.decision === 'GRANT')).toHaveLength(1);
      expect(await h.prisma.mealUsage.count({ where: { studentId: s.id } })).toBe(1);
    });

    it('a student without a meal plan never consumes a sitting', async () => {
      const s = await makeStudent(h.prisma, { meal: false });
      const c = await makeCard(h.prisma, s.id);
      expect(await scan(cafe, c)).toMatchObject({ decision: 'DENY', reason_code: 'NO_MEAL_PLAN' });
      expect(await h.prisma.mealUsage.count({ where: { studentId: s.id } })).toBe(0);
    });

    it('refuses outside every sitting', async () => {
      // every sitting (not just breakfast), otherwise the result depends on the hour the suite happens to run
      const saved = await h.prisma.mealSitting.findMany();
      await h.prisma.mealSitting.updateMany({ data: { startsAt: '03:00', endsAt: '03:01' } });
      try {
        const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
        const midday = new Date().getHours() === 3 && new Date().getMinutes() <= 1;
        if (!midday) expect(await scan(cafe, c)).toMatchObject({ decision: 'DENY', reason_code: 'OUTSIDE_TIME_WINDOW' });
      } finally {
        for (const m of saved) await h.prisma.mealSitting.update({ where: { id: m.id }, data: { startsAt: m.startsAt, endsAt: m.endsAt } });
        await openMealsAllDay(h.prisma);
      }
    });
  });

  describe('lecture attendance', () => {
    it('records attendance once for an enrolled student; unenrolled and out-of-timetable scans are refused', async () => {
      const lec = await makeLiveLecture(h.prisma, 'LH-1', 'CSC2201');
      const s = await makeStudent(h.prisma, { enrol: ['CSC2201'] });
      const c = await makeCard(h.prisma, s.id);
      expect(await scan(lecture, c)).toMatchObject({ decision: 'GRANT' });
      expect(await scan(lecture, c)).toMatchObject({ decision: 'GRANT' });
      expect(await h.prisma.lectureAttendance.count({ where: { scheduleId: lec.id, studentId: s.id } })).toBe(1);

      const other = await makeStudent(h.prisma);
      expect(await scan(lecture, await makeCard(h.prisma, other.id))).toMatchObject({ decision: 'DENY' });
      expect(await h.prisma.lectureAttendance.count({ where: { studentId: other.id } })).toBe(0);

      await h.prisma.lectureSchedule.update({ where: { id: lec.id }, data: { dayOfWeek: (new Date().getDay() + 3) % 7 } }); // moved to another weekday
      expect(await scan(lecture, c)).toMatchObject({ decision: 'DENY', reason_code: 'OUTSIDE_TIME_WINDOW' });
    });
  });

  describe('hostel access', () => {
    it('grants only the student allocated to this hostel', async () => {
      const hostelA = await h.prisma.hostel.findUniqueOrThrow({ where: { code: 'HA' } });
      const hostelB = await h.prisma.hostel.findUniqueOrThrow({ where: { code: 'HB' } });
      const sem = await h.prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
      const mine = await makeStudent(h.prisma);
      const theirs = await makeStudent(h.prisma);
      await h.prisma.hostelAllocation.create({ data: { studentId: mine.id, hostelId: hostelA.id, semesterId: sem.id } });
      await h.prisma.hostelAllocation.create({ data: { studentId: theirs.id, hostelId: hostelB.id, semesterId: sem.id } });
      expect(await scan(hostel, await makeCard(h.prisma, mine.id))).toMatchObject({ decision: 'GRANT' });
      expect(await scan(hostel, await makeCard(h.prisma, theirs.id))).toMatchObject({ decision: 'DENY', reason_code: 'HOSTEL_NOT_ASSIGNED' });
    });
  });

  describe('Finance and Registry (demo 3 / TC-08)', () => {
    it('a Finance update changes the very next scan, is audited with before/after, and notifies the student', async () => {
      const { courseCode } = await makeExam(h.prisma, 'EXH-A');
      const s = await makeStudent(h.prisma, { enrol: [courseCode], examCleared: false, fees: 40 });
      const c = await makeCard(h.prisma, s.id);
      expect(await scan(exam, c)).toMatchObject({ decision: 'DENY', reason_code: 'FINANCE_NOT_CLEARED' });

      const res = await h.http().patch(`/api/v1/finance/students/${s.regNo}`).set(bearer(finance))
        .send({ feesPaidPercent: 100, examCleared: true, reason: 'Receipt FIN-0001 verified' }).expect(200);
      expect(res.body).toMatchObject({ examCleared: true, feesPaidPercent: 100 });
      expect(await scan(exam, c)).toMatchObject({ decision: 'GRANT' });

      const audit = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'finance.status_update', entityId: (await h.prisma.studentStatus.findFirstOrThrow({ where: { studentId: s.id } })).id } });
      expect(audit.reason).toBe('Receipt FIN-0001 verified');
      expect(audit.before).toMatchObject({ examCleared: false, feesPaidPercent: 40 });
      expect(audit.after).toMatchObject({ examCleared: true, feesPaidPercent: 100 });
      expect(await h.prisma.notification.count({ where: { studentId: s.id, kind: 'FINANCE_CLEARANCE' } })).toBe(1);
    });

    it('requires a reason, a change, and the right permission', async () => {
      const s = await makeStudent(h.prisma);
      const url = `/api/v1/finance/students/${s.regNo}`;
      await h.http().patch(url).set(bearer(finance)).send({ examCleared: true }).expect(400);
      await h.http().patch(url).set(bearer(finance)).send({ reason: 'No fields supplied' }).expect(409);
      await h.http().patch(url).set(bearer(cardOfficer)).send({ examCleared: false, reason: 'Not my job' }).expect(403);
      await h.http().patch(url).send({ examCleared: false, reason: 'Anonymous' }).expect(401);
      await h.http().patch(`/api/v1/finance/students/NOPE-1`).set(bearer(finance)).send({ examCleared: false, reason: 'Unknown student' }).expect(404);
      await h.http().patch(url).set(bearer(finance)).send({ feesPaidPercent: 101, reason: 'Out of range' }).expect(400);
    });

    it('lists students with a clearance filter', async () => {
      const res = await h.http().get('/api/v1/finance/students?clearance=pending&pageSize=5').set(bearer(finance)).expect(200);
      expect(res.body.data.every((r: { examCleared: boolean }) => r.examCleared === false)).toBe(true);
      await h.http().get('/api/v1/finance/students').set(bearer(librarian)).expect(403);
    });

    it('Registry registration changes the next decision', async () => {
      await makeLiveLecture(h.prisma, 'LH-1', 'CSC2201');
      const s = await makeStudent(h.prisma, { enrol: ['CSC2201'] });
      const c = await makeCard(h.prisma, s.id);
      expect((await scan(lecture, c)).decision).toBe('GRANT');
      await h.http().patch(`/api/v1/registry/students/${s.regNo}/registration`).set(bearer(registry)).send({ semesterRegistered: false, reason: 'Deregistered by Registry' }).expect(200);
      expect(await scan(lecture, c)).toMatchObject({ decision: 'DENY', reason_code: 'NOT_REGISTERED' });
      await h.http().patch(`/api/v1/registry/students/${s.regNo}/registration`).set(bearer(finance)).send({ semesterRegistered: true, reason: 'Wrong role' }).expect(403);
    });
  });

  describe('Library loans and returns (demo 4 / TC-05)', () => {
    it('an overdue loan blocks borrowing; returning it lifts the block on the next scan', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id);
      await h.prisma.libraryLoan.create({ data: { studentId: s.id, itemRef: 'BK-OLD1', title: 'Old book', dueAt: new Date(Date.now() - 3 * 86_400_000), status: 'ACTIVE' } });

      // The next library action recomputes: a late ACTIVE loan becomes OVERDUE and the count feeds the rules.
      const list = await h.http().get(`/api/v1/library/loans?regNo=${s.regNo}`).set(bearer(librarian)).expect(200);
      expect(list.body.data).toHaveLength(1);
      await h.http().post('/api/v1/library/loans').set(bearer(librarian)).send({ regNo: s.regNo, itemRef: 'BK-NEW1', title: 'Another' }).expect(409);
      const loan = await h.prisma.libraryLoan.findFirstOrThrow({ where: { studentId: s.id } });
      expect(loan.status).toBe('OVERDUE');
      expect(await scan(borrow, c)).toMatchObject({ decision: 'DENY', reason_code: 'LIBRARY_OVERDUE' });

      const ret = await h.http().post(`/api/v1/library/loans/${loan.id}/return`).set(bearer(librarian)).expect(200);
      expect(ret.body).toMatchObject({ status: 'RETURNED', overdueItemsNow: 0 });
      expect(await scan(borrow, c)).toMatchObject({ decision: 'GRANT' });
      await h.http().post(`/api/v1/library/loans/${loan.id}/return`).set(bearer(librarian)).expect(409);

      const lend = await h.http().post('/api/v1/library/loans').set(bearer(librarian)).send({ regNo: s.regNo, itemRef: 'BK-NEW1', title: 'Another', days: 7 }).expect(201);
      expect(lend.body.status).toBe('ACTIVE');
      expect(await h.prisma.auditTrail.count({ where: { action: { in: ['library.loan_created', 'library.loan_returned'] } } })).toBeGreaterThanOrEqual(2);
    });

    it('fines above the policy limit block borrowing and can be cleared by a librarian', async () => {
      const s = await makeStudent(h.prisma, { fines: 90_000 });
      const c = await makeCard(h.prisma, s.id);
      expect(await scan(borrow, c)).toMatchObject({ decision: 'DENY', reason_code: 'LIBRARY_FINES' });
      await h.http().patch(`/api/v1/library/students/${s.regNo}/fines`).set(bearer(librarian)).send({ fineUgx: 0, reason: 'Fine paid at counter' }).expect(200);
      expect(await scan(borrow, c)).toMatchObject({ decision: 'GRANT' });
      await h.http().patch(`/api/v1/library/students/${s.regNo}/fines`).set(bearer(cardOfficer)).send({ fineUgx: 0, reason: 'Wrong role' }).expect(403);
    });
  });
});
