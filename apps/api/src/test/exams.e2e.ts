import { Harness, bearer, startHarness } from './harness';
import { seedDemo } from '../seed/demo';
import { adminToken, makeCard, makeStudent, provisionReader, staffToken, verify } from './access-fixtures';

describe('examination scheduling and attendance (e2e, real PostgreSQL)', () => {
  let h: Harness;
  let registry: string, invigilator: string, finance: string, admin: string;
  let n = 0;

  beforeAll(async () => {
    h = await startHarness();
    await seedDemo(h.prisma, { students: 12 });
    registry = await staffToken(h, 'REGISTRY_OFFICER');
    invigilator = await staffToken(h, 'INVIGILATOR');
    finance = await staffToken(h, 'FINANCE_OFFICER');
    admin = await adminToken(h);
  }, 120_000);
  afterAll(async () => { await h.close(); });

  const post = (p: string, t: string, b: object) => h.http().post(`/api/v1${p}`).set(bearer(t)).send(b);
  const get = (p: string, t: string) => h.http().get(`/api/v1${p}`).set(bearer(t));

  async function freshCourse() {
    const dept = await h.prisma.department.findFirstOrThrow();
    return h.prisma.courseUnit.create({ data: { code: `TST${Date.now() % 100000}${n++}`, title: 'Test course', departmentId: dept.id } });
  }
  // Far-future, unique day per call so sessions never overlap other suites' data.
  const slot = (dayOffset: number, hour = 9, hours = 3) => {
    const s = new Date(Date.UTC(2031, 0, 1 + dayOffset, hour));
    return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + hours * 3_600_000).toISOString() };
  };
  const body = (courseCode: string, extra: object = {}) => ({ courseCode, venueCode: 'EXH-A', reason: 'Timetable approved by senate', ...slot(10 + n), ...extra });

  it('creates a session with default entry window, audits it, and lists it as upcoming', async () => {
    const c = await freshCourse();
    const b = body(c.code);
    const res = await post('/exams/sessions', registry, b).expect(201);
    expect(new Date(res.body.entryOpensAt).getTime()).toBe(new Date(b.startsAt).getTime() - 60 * 60_000);
    expect(new Date(res.body.entryClosesAt).getTime()).toBe(new Date(b.startsAt).getTime() + 30 * 60_000);
    const list = await get('/exams/sessions?when=upcoming&pageSize=100', registry).expect(200);
    expect(list.body.data.find((x: { id: string }) => x.id === res.body.id)).toMatchObject({ courseCode: c.code, venueCode: 'EXH-A', attendanceCount: 0 });
    const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'exams.session_created', entityId: res.body.id } });
    expect(a.reason).toBe('Timetable approved by senate');
  });

  it('refuses invalid windows, unknown refs, non-halls, duplicates and venue clashes', async () => {
    const c = await freshCourse();
    const ok = body(c.code);
    const code = async (b: object, status: number) => (await post('/exams/sessions', registry, b).expect(status)).body.code;
    expect(await code({ ...ok, endsAt: ok.startsAt }, 409)).toBe('INVALID_WINDOW');
    expect(await code({ ...ok, endsAt: new Date(new Date(ok.startsAt).getTime() + 13 * 3_600_000).toISOString() }, 409)).toBe('INVALID_WINDOW');
    expect(await code({ ...ok, courseCode: 'NOPE' }, 404)).toBe('COURSE_NOT_FOUND');
    expect(await code({ ...ok, venueCode: 'NOPE' }, 404)).toBe('VENUE_NOT_FOUND');
    expect(await code({ ...ok, venueCode: 'GATE-MAIN-V' }, 404)).toBe('VENUE_NOT_FOUND');
    const nonHall = await h.prisma.venue.findFirstOrThrow({ where: { kind: { not: 'EXAM_HALL' } } });
    expect(await code({ ...ok, venueCode: nonHall.code }, 409)).toBe('NOT_EXAM_HALL');
    await post('/exams/sessions', registry, { ...ok, startsAt: 'tomorrow' }).expect(400);
    await post('/exams/sessions', registry, { ...ok, reason: 'x' }).expect(400);
    await post('/exams/sessions', registry, ok).expect(201);
    expect(await code(ok, 409)).toBe('ALREADY_SCHEDULED');
    const other = await freshCourse();
    expect(await code({ ...ok, courseCode: other.code }, 409)).toBe('VENUE_CLASH');
    await post('/exams/sessions', registry, { ...ok, courseCode: other.code, venueCode: 'EXH-B' }).expect(201);
  });

  it('cancels a session with a reason unless attendance exists', async () => {
    const c = await freshCourse(), d = await freshCourse();
    const a = (await post('/exams/sessions', registry, body(c.code)).expect(201)).body.id as string;
    const b = (await post('/exams/sessions', registry, body(d.code, { venueCode: 'EXH-B' })).expect(201)).body.id as string;
    const s = await makeStudent(h.prisma, {});
    await h.prisma.examAttendance.create({ data: { examSessionId: b, studentId: s.id } });
    expect((await post(`/exams/sessions/${b}/cancel`, registry, { reason: 'Venue unavailable' }).expect(409)).body.code).toBe('HAS_ATTENDANCE');
    await post(`/exams/sessions/${a}/cancel`, registry, { reason: 'x' }).expect(400);
    await post(`/exams/sessions/${a}/cancel`, registry, { reason: 'Moved to next semester' }).expect(200);
    expect(await h.prisma.examSession.count({ where: { id: a } })).toBe(0);
    expect(await h.prisma.auditTrail.count({ where: { action: 'exams.session_cancelled', entityId: a } })).toBe(1);
    await post(`/exams/sessions/${a}/cancel`, registry, { reason: 'Moved to next semester' }).expect(404);
  });

  it('lists attendance for invigilators and not for roles without exams.attendance.view', async () => {
    const c = await freshCourse();
    const id = (await post('/exams/sessions', registry, body(c.code)).expect(201)).body.id as string;
    const s = await makeStudent(h.prisma, {});
    await h.prisma.examAttendance.create({ data: { examSessionId: id, studentId: s.id } });
    const res = await get(`/exams/sessions/${id}/attendance`, invigilator).expect(200);
    expect(res.body.course.code).toBe(c.code);
    expect(res.body.data).toEqual([expect.objectContaining({ regNo: s.regNo, status: 'PRESENT' })]);
    await get(`/exams/sessions/${id}/attendance`, registry).expect(403);
    await get('/exams/sessions/00000000-0000-4000-8000-000000000000/attendance', admin).expect(404);
  });

  it('enforces permissions: view vs manage, and anonymous', async () => {
    const c = await freshCourse();
    await get('/exams/sessions', finance).expect(403);
    await post('/exams/sessions', invigilator, body(c.code)).expect(403);
    await h.http().get('/api/v1/exams/sessions').expect(401);
    expect((await get('/exams/halls', registry).expect(200)).body.some((v: { code: string }) => v.code === 'EXH-A')).toBe(true);
    expect((await get('/exams/sessions?when=past', invigilator).expect(200)).body.meta).toBeDefined();
  });

  describe('seating', () => {
    it('auto-assigns enrolled students in registration order, never twice, then shows the seat at admission', async () => {
      const c = await freshCourse();
      const sem = await h.prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
      const students = [];
      for (let i = 0; i < 3; i++) { const st = await makeStudent(h.prisma, {}); await h.prisma.enrolment.create({ data: { studentId: st.id, courseUnitId: c.id, semesterId: sem.id } }); students.push(st); }
      // open entry window now, in a hall of capacity 300
      const now = Date.now();
      const e = await h.prisma.examSession.create({ data: { courseUnitId: c.id, semesterId: sem.id, venueId: (await h.prisma.venue.findUniqueOrThrow({ where: { code: 'EXH-B' } })).id, startsAt: new Date(now), endsAt: new Date(now + 3 * 3_600_000), entryOpensAt: new Date(now - 3_600_000), entryClosesAt: new Date(now + 3_600_000) } });

      await post(`/exams/sessions/${e.id}/seats/auto-assign`, invigilator, { reason: 'Seat the hall' }).expect(403);
      await post(`/exams/sessions/${e.id}/seats/auto-assign`, registry, { reason: 'x' }).expect(400);
      expect((await post(`/exams/sessions/${e.id}/seats/auto-assign`, registry, { reason: 'Seat the hall' }).expect(200)).body.assigned).toBe(3);
      expect((await post(`/exams/sessions/${e.id}/seats/auto-assign`, registry, { reason: 'Seat again' }).expect(409)).body.code).toBe('NOTHING_TO_ASSIGN');
      const view = (await get(`/exams/sessions/${e.id}/seats`, registry).expect(200)).body;
      expect(view).toMatchObject({ seated: 3, unseated: 0, enrolled: 3, capacity: 200 });
      expect(view.data.map((r: { seatLabel: string }) => r.seatLabel)).toEqual(['A1', 'A2', 'A3']);

      // manual changes: taken seat refused, move allowed, non-enrolled refused
      const [s1, s2] = students as [typeof students[0], typeof students[0]];
      const s1Before = view.data.find((r: { regNo: string }) => r.regNo === s1!.regNo).seatLabel as string;
      const other = view.data.find((r: { regNo: string }) => r.regNo !== s1!.regNo).seatLabel as string;
      expect((await post(`/exams/sessions/${e.id}/seats`, registry, { regNo: s1!.regNo, seatLabel: other, reason: 'Closer to door' }).expect(409)).body.code).toBe('SEAT_TAKEN');
      await post(`/exams/sessions/${e.id}/seats`, registry, { regNo: s1!.regNo, seatLabel: 'C7', reason: 'Closer to door' }).expect(201);
      const outsider = await makeStudent(h.prisma, {});
      expect((await post(`/exams/sessions/${e.id}/seats`, registry, { regNo: outsider.regNo, seatLabel: 'D1', reason: 'Late addition' }).expect(409)).body.code).toBe('NOT_ENROLLED');
      await post(`/exams/sessions/${e.id}/seats`, registry, { regNo: s2!.regNo, seatLabel: 'bad', reason: 'Invalid label here' }).expect(400);
      const a = await h.prisma.auditTrail.findFirstOrThrow({ where: { action: 'exams.seat_set', entityId: e.id }, orderBy: { seq: 'desc' } });
      expect(a.before).toMatchObject({ seatLabel: s1Before });

      // admission tells the student their seat
      const reader = await provisionReader(h, admin, 'EXAM', 'EXH-B');
      const card = await makeCard(h.prisma, s1!.id);
      const res = (await verify(h, reader, card.qr()).expect(200)).body;
      expect(res).toMatchObject({ decision: 'GRANT', message: 'Access granted. Your seat is C7.' });
    });

    it('refuses to seat more students than the hall holds', async () => {
      const c = await freshCourse();
      const sem = await h.prisma.semester.findFirstOrThrow({ where: { isCurrent: true } });
      for (let i = 0; i < 2; i++) { const st = await makeStudent(h.prisma, {}); await h.prisma.enrolment.create({ data: { studentId: st.id, courseUnitId: c.id, semesterId: sem.id } }); }
      const small = await h.prisma.venue.create({ data: { code: `SM${Date.now() % 100000}`, name: 'Tiny hall', kind: 'EXAM_HALL', capacity: 1 } });
      const e = await h.prisma.examSession.create({ data: { courseUnitId: c.id, semesterId: sem.id, venueId: small.id, startsAt: new Date(Date.UTC(2032, 0, 5, 9)), endsAt: new Date(Date.UTC(2032, 0, 5, 12)), entryOpensAt: new Date(Date.UTC(2032, 0, 5, 8)), entryClosesAt: new Date(Date.UTC(2032, 0, 5, 10)) } });
      expect((await post(`/exams/sessions/${e.id}/seats/auto-assign`, registry, { reason: 'Seat the hall' }).expect(409)).body.code).toBe('OVER_CAPACITY');
    });
  });
});
