/**
 * DEMONSTRATION DATA — every person, record and credential below is FICTIONAL and for
 * development only. Never run against a real student register.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { ROLE_DEFINITIONS } from '@kiu/shared';
import { seedRules } from './rules';
import { SERVICE_CATALOG } from './service-catalog';

export const DEMO_PASSWORD = 'Demo-Password-2026!';

const FIRST = ['Amina', 'Brian', 'Cecilia', 'David', 'Esther', 'Felix', 'Grace', 'Hassan', 'Irene', 'Joseph', 'Kevin', 'Lydia', 'Moses', 'Nancy', 'Oscar', 'Patience', 'Quincy', 'Ruth', 'Samuel', 'Tendo'];
const LAST = ['Akello', 'Byaruhanga', 'Chebet', 'Dhillon', 'Ekiru', 'Faith', 'Gumisiriza', 'Hakim', 'Isabirye', 'Jjuuko', 'Kato', 'Lubega', 'Mugisha', 'Nakato', 'Okello', 'Peters', 'Rwabwogo', 'Ssemanda', 'Tumusiime', 'Wanyama'];

const DEPARTMENTS = [
  { code: 'CS', name: 'Computer Science', faculty: 'Science & Technology' },
  { code: 'BUS', name: 'Business Administration', faculty: 'Business & Management' },
  { code: 'LAW', name: 'Law', faculty: 'Law' },
  { code: 'EDU', name: 'Education', faculty: 'Education' },
];
const PROGRAMMES = [
  { code: 'BCS', name: 'BSc Computer Science', dept: 'CS' },
  { code: 'BIT', name: 'BSc Information Technology', dept: 'CS' },
  { code: 'BBA', name: 'Bachelor of Business Administration', dept: 'BUS' },
  { code: 'LLB', name: 'Bachelor of Laws', dept: 'LAW' },
  { code: 'BED', name: 'Bachelor of Education', dept: 'EDU' },
];
const COURSES = [
  { code: 'CSC1101', title: 'Programming Fundamentals', dept: 'CS' },
  { code: 'CSC1102', title: 'Discrete Mathematics', dept: 'CS' },
  { code: 'CSC2201', title: 'Data Structures', dept: 'CS' },
  { code: 'CSC2202', title: 'Databases', dept: 'CS' },
  { code: 'BBA1101', title: 'Principles of Management', dept: 'BUS' },
  { code: 'BBA1102', title: 'Financial Accounting', dept: 'BUS' },
  { code: 'LAW1101', title: 'Constitutional Law', dept: 'LAW' },
  { code: 'LAW1102', title: 'Law of Contract', dept: 'LAW' },
  { code: 'EDU1101', title: 'Foundations of Education', dept: 'EDU' },
  { code: 'EDU1102', title: 'Educational Psychology', dept: 'EDU' },
];
const VENUES = [
  { code: 'GATE-MAIN', name: 'Main Gate', kind: 'GATE' },
  { code: 'LIB-MAIN', name: 'Main Library', kind: 'LIBRARY' },
  { code: 'EXH-A', name: 'Examination Hall A', kind: 'EXAM_HALL', capacity: 300 },
  { code: 'EXH-B', name: 'Examination Hall B', kind: 'EXAM_HALL', capacity: 200 },
  { code: 'LH-1', name: 'Lecture Hall 1', kind: 'LECTURE_ROOM', capacity: 120 },
  { code: 'HOSTEL-A', name: 'Hostel A (Women)', kind: 'HOSTEL' },
  { code: 'HOSTEL-B', name: 'Hostel B (Men)', kind: 'HOSTEL' },
  { code: 'CAF-MAIN', name: 'Main Cafeteria', kind: 'CAFETERIA' },
  { code: 'LAB-1', name: 'Computer Laboratory 1', kind: 'LAB', opensAt: '08:00', closesAt: '20:00' },
  { code: 'HEALTH-1', name: 'Health Centre', kind: 'HEALTH' },
];
/** Small deterministic PRNG so the seeded register is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoResult {
  students: number;
  staffAccounts: number;
}

export async function seedDemo(prisma: PrismaClient, opts: { students?: number } = {}): Promise<DemoResult> {
  const studentCount = opts.students ?? 60;
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const rand = mulberry32(20261114);

  // ── Academic structure ──
  const dept = new Map<string, string>();
  for (const d of DEPARTMENTS) dept.set(d.code, (await prisma.department.upsert({ where: { code: d.code }, update: {}, create: d })).id);
  const prog = new Map<string, string>();
  for (const p of PROGRAMMES) prog.set(p.code, (await prisma.programme.upsert({ where: { code: p.code }, update: {}, create: { code: p.code, name: p.name, departmentId: dept.get(p.dept)! } })).id);
  const course = new Map<string, { id: string; dept: string }>();
  for (const c of COURSES) {
    const row = await prisma.courseUnit.upsert({ where: { code: c.code }, update: {}, create: { code: c.code, title: c.title, departmentId: dept.get(c.dept)! } });
    course.set(c.code, { id: row.id, dept: c.dept });
  }

  const now = new Date();
  const session = await prisma.academicSession.upsert({
    where: { code: '2026/2027' }, update: { isCurrent: true },
    create: { code: '2026/2027', startsOn: new Date('2026-08-24'), endsOn: new Date('2027-07-31'), isCurrent: true },
  });
  const semester = await prisma.semester.upsert({
    where: { sessionId_number: { sessionId: session.id, number: 1 } }, update: { isCurrent: true },
    create: { sessionId: session.id, number: 1, startsOn: new Date('2026-08-24'), endsOn: new Date('2026-12-18'), isCurrent: true },
  });

  // ── Venues, services, hostels, meal sittings ──
  const venue = new Map<string, string>();
  for (const v of VENUES) venue.set(v.code, (await prisma.venue.upsert({ where: { code: v.code }, update: {}, create: v })).id);
  const service = new Map<string, string>();
  for (const s of SERVICE_CATALOG) {
    const row = await prisma.service.upsert({
      where: { code: s.code }, update: {},
      create: { code: s.code, name: s.name, offlinePolicy: s.offline, requiresDirection: s.direction ?? false, sensitivity: s.sensitivity ?? 'NORMAL' },
    });
    service.set(s.code, row.id);
  }
  const hostelA = await prisma.hostel.upsert({ where: { code: 'HA' }, update: {}, create: { code: 'HA', name: 'Hostel A', venueId: venue.get('HOSTEL-A')! } });
  const hostelB = await prisma.hostel.upsert({ where: { code: 'HB' }, update: {}, create: { code: 'HB', name: 'Hostel B', venueId: venue.get('HOSTEL-B')! } });
  for (const [mealType, startsAt, endsAt] of [['BREAKFAST', '06:30', '09:30'], ['LUNCH', '12:00', '14:30'], ['DINNER', '18:00', '20:30']] as const) {
    await prisma.mealSitting.upsert({
      where: { serviceId_mealType: { serviceId: service.get('CAFETERIA')!, mealType } }, update: {},
      create: { serviceId: service.get('CAFETERIA')!, mealType, startsAt, endsAt },
    });
  }

  // ── Exam sessions + lectures (relative to seed time; a slot that has already ended today rolls to tomorrow,
  //    so a freshly seeded demo always has upcoming examinations) ──
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const at = (h: number, m = 0) => new Date(day.getTime() + h * 3_600_000 + m * 60_000);
  const examPlans = [
    { cu: 'CSC1101', v: 'EXH-A', s: [9, 0], e: [12, 0] },
    { cu: 'BBA1101', v: 'EXH-B', s: [9, 0], e: [12, 0] },
    { cu: 'LAW1101', v: 'EXH-A', s: [14, 0], e: [17, 0] },
    { cu: 'EDU1101', v: 'EXH-B', s: [14, 0], e: [17, 0] },
  ] as const;
  for (const p of examPlans) {
    const exists = await prisma.examSession.findFirst({ where: { courseUnitId: course.get(p.cu)!.id, semesterId: semester.id } });
    if (!exists) {
      const shift = at(p.e[0], p.e[1]) < now ? 86_400_000 : 0;
      const t = (h: number, m = 0) => new Date(at(h, m).getTime() + shift);
      await prisma.examSession.create({
        data: {
          courseUnitId: course.get(p.cu)!.id, semesterId: semester.id, venueId: venue.get(p.v)!,
          startsAt: t(p.s[0], p.s[1]), endsAt: t(p.e[0], p.e[1]),
          entryOpensAt: t(p.s[0] - 1, 30), entryClosesAt: t(p.s[0] + 1),
        },
      });
    }
  }
  if ((await prisma.lectureSchedule.count()) === 0) {
    await prisma.lectureSchedule.createMany({
      data: [
        { courseUnitId: course.get('CSC2201')!.id, venueId: venue.get('LH-1')!, dayOfWeek: 1, startsAt: '10:00', endsAt: '12:00' },
        { courseUnitId: course.get('CSC2202')!.id, venueId: venue.get('LH-1')!, dayOfWeek: 3, startsAt: '14:00', endsAt: '16:00' },
      ],
    });
  }

  // ── Staff demo accounts: one per non-student role ──
  const roleRows = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));
  let staffAccounts = 0;
  for (const def of ROLE_DEFINITIONS.filter((r) => r.code !== 'STUDENT')) {
    const email = `${def.code.toLowerCase().replace(/_/g, '-')}@kiu-demo.test`;
    const user = await prisma.user.upsert({
      where: { email }, update: {},
      create: { email, displayName: `${def.name} (Demo)`, passwordHash, userType: 'STAFF' },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: roleRows.get(def.code)! } }, update: {},
      create: { userId: user.id, roleId: roleRows.get(def.code)! },
    });
    staffAccounts++;
  }

  // ── Fictional students with a deliberate spread of eligibility situations ──
  let created = 0;
  for (let i = 1; i <= studentCount; i++) {
    const p = PROGRAMMES[(i - 1) % PROGRAMMES.length]!;
    const regNo = `2026-${p.code}-${String(i).padStart(4, '0')}`;
    const fullName = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    const existing = await prisma.student.findUnique({ where: { regNo } });
    if (existing) continue;

    const feesPaid = i % 10 === 0 ? 40 : i % 5 === 0 ? 75 : 100;
    const accountStatus = i === 13 ? 'SUSPENDED' : i === 17 ? 'WITHDRAWN' : 'ACTIVE';
    const overdue = i % 9 === 0 ? 2 : i % 14 === 0 ? 1 : 0;
    const fines = i % 11 === 0 ? 60_000 : overdue > 0 ? 15_000 : 0;

    const student = await prisma.student.create({
      data: {
        regNo, fullName, programmeId: prog.get(p.code)!, yearOfStudy: 1 + (i % 3), accountStatus,
        email: `${regNo.toLowerCase().replace(/[^a-z0-9]/g, '.')}@students.kiu-demo.test`, isFictional: true,
      },
    });
    await prisma.studentStatus.create({
      data: {
        studentId: student.id, semesterId: semester.id,
        semesterRegistered: i % 7 !== 0,
        feesPaidPercent: new Prisma.Decimal(feesPaid),
        examCleared: feesPaid >= 100, // seed convention only; the real clearance policy is configurable and unconfirmed
        libraryOverdueItems: overdue, libraryFinesUgx: fines,
        hostelFeesPaid: i % 6 !== 0, mealPlanActive: i % 2 === 0,
      },
    });

    const mine = COURSES.filter((c) => c.dept === p.dept).slice(0, 3);
    for (const c of mine) await prisma.enrolment.create({ data: { studentId: student.id, courseUnitId: course.get(c.code)!.id, semesterId: semester.id } });

    if (i % 3 === 0) {
      await prisma.hostelAllocation.create({ data: { studentId: student.id, hostelId: i % 2 === 0 ? hostelA.id : hostelB.id, roomNo: `R${100 + i}`, semesterId: semester.id } });
    }
    for (let k = 0; k < overdue; k++) {
      await prisma.libraryLoan.create({
        data: { studentId: student.id, itemRef: `BK-${i}-${k}`, title: `Reference Text ${k + 1}`, borrowedAt: new Date(now.getTime() - 40 * 86_400_000), dueAt: new Date(now.getTime() - 14 * 86_400_000), status: 'OVERDUE', fineUgx: 7_500 },
      });
    }

    // Student web account for the first 12 students (portal demos).
    if (i <= 12) {
      const u = await prisma.user.create({
        data: { email: `student${String(i).padStart(2, '0')}@kiu-demo.test`, displayName: fullName, passwordHash, userType: 'STUDENT', studentId: student.id },
      });
      await prisma.userRole.create({ data: { userId: u.id, roleId: roleRows.get('STUDENT')! } });
    }
    created++;
  }

  await seedRules(prisma);
  const total = await prisma.student.count();
  return { students: total, staffAccounts };
}
