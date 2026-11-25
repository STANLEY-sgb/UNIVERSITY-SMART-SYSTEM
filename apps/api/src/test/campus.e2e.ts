import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { ReaderCreds, adminToken, makeCard, makeLiveLecture, makeStudent, openMealsAllDay, provisionReader, staffToken, verify } from './access-fixtures';

describe('hostel, cafeteria and timetable management (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let warden: string, cafeteria: string, registry: string, finance: string;
  let hostelReader: ReaderCreds, lectureReader: ReaderCreds, cafeReader: ReaderCreds;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    await openMealsAllDay(h.prisma);
    const admin = await adminToken(h);
    hostelReader = await provisionReader(h, admin, 'HOSTEL', 'HOSTEL-A');
    lectureReader = await provisionReader(h, admin, 'LECTURE', 'LH-1');
    cafeReader = await provisionReader(h, admin, 'CAFETERIA', 'CAF-MAIN');
    warden = await staffToken(h, 'HOSTEL_WARDEN');
    cafeteria = await staffToken(h, 'CAFETERIA_OPERATOR');
    registry = await staffToken(h, 'REGISTRY_OFFICER');
    finance = await staffToken(h, 'FINANCE_OFFICER');
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const decision = async (r: ReaderCreds, c: Awaited<ReturnType<typeof makeCard>>) => (await verify(h, r, c.qr()).expect(200)).body;

  describe('hostel allocation', () => {
    it('allocating admits the student at once; moving them replaces the old allocation; ending removes access', async () => {
      const s = await makeStudent(h.prisma);
      const c = await makeCard(h.prisma, s.id);
      expect(await decision(hostelReader, c)).toMatchObject({ decision: 'DENY', reason_code: 'HOSTEL_NOT_ASSIGNED' });

      const a = await h.http().post('/api/v1/hostels/allocations').set(bearer(warden)).send({ regNo: s.regNo, hostelCode: 'HA', roomNo: 'R12', reason: 'Room assigned by warden' }).expect(201);
      expect(a.body).toMatchObject({ hostel: 'HA', roomNo: 'R12' });
      expect(await decision(hostelReader, c)).toMatchObject({ decision: 'GRANT' });

      await h.http().post('/api/v1/hostels/allocations').set(bearer(warden)).send({ regNo: s.regNo, hostelCode: 'HB', reason: 'Transferred to Hostel B' }).expect(201);
      expect(await h.prisma.hostelAllocation.count({ where: { studentId: s.id, active: true } })).toBe(1);
      expect(await decision(hostelReader, c)).toMatchObject({ decision: 'DENY', reason_code: 'HOSTEL_NOT_ASSIGNED' });

      const current = await h.prisma.hostelAllocation.findFirstOrThrow({ where: { studentId: s.id, active: true } });
      await h.http().post(`/api/v1/hostels/allocations/${current.id}/end`).set(bearer(warden)).send({ reason: 'Left the hostel' }).expect(200);
      await h.http().post(`/api/v1/hostels/allocations/${current.id}/end`).set(bearer(warden)).send({ reason: 'Again' }).expect(409);
      expect(await h.prisma.auditTrail.count({ where: { action: { in: ['hostel.allocate', 'hostel.allocation_ended'] } } })).toBeGreaterThanOrEqual(3);
    });

    it('lists residents, requires a reason, and is permission-gated', async () => {
      const list = await h.http().get('/api/v1/hostels/allocations?hostel=HA&pageSize=5').set(bearer(warden)).expect(200);
      expect(list.body.data.every((r: { hostel: { code: string } }) => r.hostel.code === 'HA')).toBe(true);
      const hostels = await h.http().get('/api/v1/hostels').set(bearer(warden)).expect(200);
      expect(hostels.body.find((x: { code: string }) => x.code === 'HA').residents).toBeGreaterThan(0);

      const s = await makeStudent(h.prisma);
      await h.http().post('/api/v1/hostels/allocations').set(bearer(warden)).send({ regNo: s.regNo, hostelCode: 'HA' }).expect(400);
      await h.http().post('/api/v1/hostels/allocations').set(bearer(warden)).send({ regNo: s.regNo, hostelCode: 'NOPE', reason: 'Unknown hostel' }).expect(404);
      await h.http().post('/api/v1/hostels/allocations').set(bearer(finance)).send({ regNo: s.regNo, hostelCode: 'HA', reason: 'Wrong role' }).expect(403);
      await h.http().get('/api/v1/hostels').expect(401);
    });
  });

  describe('meal sittings', () => {
    it('validates the window, refuses overlaps, audits the change, and the new window governs the next scan', async () => {
      const list = await h.http().get('/api/v1/cafeteria/sittings').set(bearer(cafeteria)).expect(200);
      expect(list.body.map((x: { mealType: string }) => x.mealType)).toEqual(expect.arrayContaining(['BREAKFAST', 'LUNCH', 'DINNER']));
      const lunch = list.body.find((x: { mealType: string }) => x.mealType === 'LUNCH');
      const url = `/api/v1/cafeteria/sittings/${lunch.id}`;

      await h.http().patch(url).set(bearer(cafeteria)).send({ startsAt: '14:00', endsAt: '13:00', reason: 'Backwards window' }).expect(409);
      await h.http().patch(url).set(bearer(cafeteria)).send({ startsAt: '25:00', endsAt: '26:00', reason: 'Not a time' }).expect(400);
      await h.http().patch(url).set(bearer(cafeteria)).send({ startsAt: '12:00', endsAt: '14:30' }).expect(400);
      await h.http().patch(url).set(bearer(cafeteria)).send({ startsAt: '00:00', endsAt: '23:00', reason: 'Overlaps all day' }).expect(409); // breakfast is all-day in this test DB
      await h.http().patch(url).set(bearer(registry)).send({ startsAt: '12:00', endsAt: '14:00', reason: 'Wrong role' }).expect(403);

      // Restore realistic windows, then move breakfast away so lunch can be moved over "now".
      const bf = list.body.find((x: { mealType: string }) => x.mealType === 'BREAKFAST');
      await h.http().patch(`/api/v1/cafeteria/sittings/${bf.id}`).set(bearer(cafeteria)).send({ startsAt: '06:30', endsAt: '09:30', reason: 'Back to the normal breakfast' }).expect(200);
      const ok = await h.http().patch(url).set(bearer(cafeteria)).send({ startsAt: '10:00', endsAt: '11:00', reason: 'Late lunch trial' }).expect(200);
      expect(ok.body).toMatchObject({ startsAt: '10:00', endsAt: '11:00' });
      const audit = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'cafeteria.sitting_update', entityId: lunch.id } });
      expect(audit.before).toMatchObject({ startsAt: '12:00', endsAt: '14:30' });
      expect(audit.after).toMatchObject({ startsAt: '10:00', endsAt: '11:00' });

      // Whatever the wall clock says, the scan must agree with the configured windows.
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const inAny = (w: [number, number][]) => w.some(([a, b]) => mins >= a && mins <= b);
      const expected = inAny([[390, 570], [600, 660], [1080, 1230]]); // breakfast, new lunch, dinner
      const c = await makeCard(h.prisma, (await makeStudent(h.prisma)).id);
      const d = await decision(cafeReader, c);
      expect(d.decision === 'GRANT').toBe(expected);
      if (!expected) expect(d.reason_code).toBe('OUTSIDE_TIME_WINDOW');
    });
  });

  describe('academic structure (departments & programmes)', () => {
    it('creates a department, refuses a duplicate code, and reports its programme count', async () => {
      const created = await h.http().post('/api/v1/departments').set(bearer(registry)).send({ code: 'ENG', name: 'Engineering', faculty: 'Engineering & Applied Sciences' }).expect(201);
      expect(created.body).toMatchObject({ code: 'ENG', name: 'Engineering', faculty: 'Engineering & Applied Sciences' });
      await h.http().post('/api/v1/departments').set(bearer(registry)).send({ code: 'eng', name: 'Engineering again', faculty: 'Engineering' }).expect(409);
      await h.http().post('/api/v1/departments').set(bearer(warden)).send({ code: 'ART', name: 'Arts', faculty: 'Arts' }).expect(403);
      await h.http().post('/api/v1/departments').set(bearer(registry)).send({ code: 'X', name: 'Arts', faculty: 'Arts' }).expect(400);

      const list = await h.http().get('/api/v1/departments').set(bearer(registry)).expect(200);
      expect(list.body.find((d: { code: string }) => d.code === 'ENG')).toMatchObject({ name: 'Engineering', programmes: 0 });
      await h.http().get('/api/v1/departments').expect(401);
      const audit = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'registry.department_created', entityId: created.body.id } });
      expect(audit.after).toMatchObject({ code: 'ENG' });
    });

    it('creates a programme under an existing department, refuses an unknown department or duplicate code, and counts it on the department', async () => {
      await h.http().post('/api/v1/departments').set(bearer(registry)).send({ code: 'CVE', name: 'Civil Engineering', faculty: 'Engineering & Applied Sciences' }).expect(201);
      const created = await h.http().post('/api/v1/programmes').set(bearer(registry)).send({ code: 'BCVE', name: 'BSc Civil Engineering', departmentCode: 'cve', durationYears: 5 }).expect(201);
      expect(created.body).toMatchObject({ code: 'BCVE', name: 'BSc Civil Engineering', durationYears: 5, departmentCode: 'CVE' });

      await h.http().post('/api/v1/programmes').set(bearer(registry)).send({ code: 'BCVE2', name: 'Other', departmentCode: 'NOPE' }).expect(404);
      await h.http().post('/api/v1/programmes').set(bearer(registry)).send({ code: 'BCVE', name: 'Duplicate code', departmentCode: 'CVE' }).expect(409);
      await h.http().post('/api/v1/programmes').set(bearer(warden)).send({ code: 'BCVE3', name: 'Wrong role', departmentCode: 'CVE' }).expect(403);

      const list = await h.http().get('/api/v1/programmes').set(bearer(finance)).expect(200);
      expect(list.body.find((p: { code: string }) => p.code === 'BCVE')).toMatchObject({ departmentCode: 'CVE', durationYears: 5 });
      const dept = await h.http().get('/api/v1/departments').set(bearer(registry)).expect(200);
      expect(dept.body.find((d: { code: string }) => d.code === 'CVE')).toMatchObject({ programmes: 1 });
    });
  });

  describe('lecture timetable', () => {
    it('adds and removes lectures, refuses room clashes, and protects recorded attendance', async () => {
      const future = (new Date().getDay() + 2) % 7;
      const add = { courseCode: 'CSC2202', venueCode: 'LH-1', dayOfWeek: future, startsAt: '08:00', endsAt: '10:00' };
      const created = await h.http().post('/api/v1/lectures').set(bearer(registry)).send(add).expect(201);
      await h.http().post('/api/v1/lectures').set(bearer(registry)).send({ ...add, courseCode: 'CSC2201', startsAt: '09:00', endsAt: '11:00' }).expect(409);
      await h.http().post('/api/v1/lectures').set(bearer(registry)).send({ ...add, startsAt: '10:00', endsAt: '09:00' }).expect(409);
      await h.http().post('/api/v1/lectures').set(bearer(registry)).send({ ...add, courseCode: 'NOPE999' }).expect(404);
      await h.http().post('/api/v1/lectures').set(bearer(warden)).send(add).expect(403);
      const list = await h.http().get('/api/v1/lectures').set(bearer(registry)).expect(200);
      expect(list.body.find((l: { id: string }) => l.id === created.body.id)).toMatchObject({ courseCode: 'CSC2202', venueCode: 'LH-1', startsAt: '08:00' });
      await h.http().post(`/api/v1/lectures/${created.body.id}/remove`).set(bearer(registry)).send({ reason: 'Timetable change' }).expect(200);
      await h.http().post(`/api/v1/lectures/${created.body.id}/remove`).set(bearer(registry)).send({ reason: 'Again' }).expect(404);

      // Once students have attended, the lecture is part of the record and cannot be deleted.
      const live = await makeLiveLecture(h.prisma, 'LH-1', 'CSC2201');
      const s = await makeStudent(h.prisma, { enrol: ['CSC2201'] });
      expect((await decision(lectureReader, await makeCard(h.prisma, s.id))).decision).toBe('GRANT');
      await h.http().post(`/api/v1/lectures/${live.id}/remove`).set(bearer(registry)).send({ reason: 'Try to erase attendance' }).expect(409);
    });
  });
});
