import { Prisma, PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { seedCore } from '../seed/core';

/**
 * Verifies that the integrity rules from the spec are enforced by PostgreSQL itself,
 * independent of any application code path.
 */
describe('database constraints (real PostgreSQL)', () => {
  const prisma = new PrismaClient();
  let studentId: string;
  let semesterId: string;
  let serviceId: string;
  const hex = (bytes: number) => randomBytes(bytes).toString('hex').toUpperCase();

  beforeAll(async () => {
    await seedCore(prisma);
    const dept = await prisma.department.create({ data: { code: `T${hex(3)}`, name: 'Test Dept', faculty: 'Test' } });
    const prog = await prisma.programme.create({ data: { code: `T${hex(3)}`, name: 'Test Prog', departmentId: dept.id } });
    const student = await prisma.student.create({ data: { regNo: `C-${hex(4)}`, fullName: 'Constraint Tester', programmeId: prog.id, yearOfStudy: 1 } });
    studentId = student.id;
    const session = await prisma.academicSession.create({ data: { code: `S-${hex(3)}`, startsOn: new Date('2030-01-01'), endsOn: new Date('2030-12-31') } });
    semesterId = (await prisma.semester.create({ data: { sessionId: session.id, number: 1, startsOn: new Date('2030-01-01'), endsOn: new Date('2030-06-30') } })).id;
    serviceId = (await prisma.service.create({ data: { code: `SVC-${hex(3)}`, name: 'Test service' } })).id;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  const newCard = (status: 'ACTIVE' | 'BLOCKED' | 'LOST' | 'PENDING', extra: Partial<Prisma.CardUncheckedCreateInput> = {}) =>
    prisma.card.create({
      data: {
        cardNumber: `KIU${hex(6)}`, uidHex: hex(7), studentId, status, regNoHash: hex(32),
        issuedAt: status === 'PENDING' ? null : new Date(), expiresAt: new Date('2031-01-01'), ...extra,
      },
    });

  it('allows at most ONE active card per student, but any number of historical cards', async () => {
    const first = await newCard('ACTIVE');
    await expect(newCard('ACTIVE')).rejects.toThrow(/cards_one_active_per_student|Unique constraint/);

    // Lost-card replacement: retire the old card, then the new one may become ACTIVE.
    await prisma.card.update({ where: { id: first.id }, data: { status: 'LOST' } });
    const replacement = await newCard('ACTIVE', { replacesCardId: first.id });
    expect(replacement.status).toBe('ACTIVE');
    await newCard('BLOCKED');
    await newCard('LOST');
    expect(await prisma.card.count({ where: { studentId, status: 'ACTIVE' } })).toBe(1);
  });

  it('serialises concurrent issuance so only one ACTIVE card can win', async () => {
    const dept = await prisma.department.findFirstOrThrow();
    const prog = await prisma.programme.create({ data: { code: `R${hex(3)}`, name: 'Race', departmentId: dept.id } });
    const s = await prisma.student.create({ data: { regNo: `RC-${hex(4)}`, fullName: 'Race Tester', programmeId: prog.id, yearOfStudy: 1 } });
    const attempt = () => prisma.card.create({ data: { cardNumber: `KIU${hex(6)}`, uidHex: hex(7), studentId: s.id, status: 'ACTIVE', regNoHash: hex(32), issuedAt: new Date(), expiresAt: new Date('2031-01-01') } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, attempt));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.card.count({ where: { studentId: s.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('keeps card numbers and UIDs unique and validates their formats', async () => {
    const a = await newCard('BLOCKED');
    await expect(newCard('BLOCKED', { cardNumber: a.cardNumber })).rejects.toThrow();
    await expect(newCard('BLOCKED', { uidHex: a.uidHex })).rejects.toThrow();
    await expect(newCard('BLOCKED', { uidHex: 'ZZ' })).rejects.toThrow(/cards_uid_format/);
    await expect(newCard('BLOCKED', { aidHex: '123' })).rejects.toThrow(/cards_aid_format/);
    await expect(newCard('ACTIVE', { issuedAt: null })).rejects.toThrow(/cards_active_has_issued_at/);
    // never-activated cards may be retired without an issue date
    await expect(prisma.card.create({ data: { cardNumber: `KIU${hex(6)}`, uidHex: hex(7), studentId, status: 'EXPIRED', regNoHash: hex(32), expiresAt: new Date('2031-01-01') } })).resolves.toBeDefined();
  });

  it('rejects duplicate registration numbers', async () => {
    const s = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    await expect(prisma.student.create({ data: { regNo: s.regNo, fullName: 'Dup', programmeId: s.programmeId, yearOfStudy: 1 } })).rejects.toThrow(/Unique constraint/);
  });

  it('prevents duplicate meal claims per student, sitting and day', async () => {
    const sitting = await prisma.mealSitting.create({ data: { serviceId, mealType: 'LUNCH', startsAt: '12:00', endsAt: '14:00' } });
    const day = new Date('2030-03-01');
    await prisma.mealUsage.create({ data: { studentId, sittingId: sitting.id, servedOn: day } });
    await expect(prisma.mealUsage.create({ data: { studentId, sittingId: sitting.id, servedOn: day } })).rejects.toThrow(/Unique constraint/);
    await expect(prisma.mealUsage.create({ data: { studentId, sittingId: sitting.id, servedOn: new Date('2030-03-02') } })).resolves.toBeDefined();
  });

  it('prevents duplicate exam attendance regardless of which route recorded it', async () => {
    const venue = await prisma.venue.create({ data: { code: `V-${hex(3)}`, name: 'Hall', kind: 'EXAM_HALL' } });
    const dept = await prisma.department.findFirstOrThrow();
    const cu = await prisma.courseUnit.create({ data: { code: `CU${hex(3)}`, title: 'Course', departmentId: dept.id } });
    const t0 = new Date('2030-03-01T09:00:00Z');
    const exam = await prisma.examSession.create({
      data: { courseUnitId: cu.id, semesterId, venueId: venue.id, startsAt: t0, endsAt: new Date(t0.getTime() + 3 * 3600_000), entryOpensAt: new Date(t0.getTime() - 1800_000), entryClosesAt: new Date(t0.getTime() + 3600_000) },
    });
    await prisma.examAttendance.create({ data: { examSessionId: exam.id, studentId } });
    await expect(prisma.examAttendance.create({ data: { examSessionId: exam.id, studentId } })).rejects.toThrow(/Unique constraint/);

    await expect(prisma.examSession.create({
      data: { courseUnitId: cu.id, semesterId, venueId: venue.id, startsAt: t0, endsAt: new Date(t0.getTime() - 1000), entryOpensAt: t0, entryClosesAt: t0 },
    })).rejects.toThrow(/exam_sessions_time_order/);
  });

  it('rejects impossible eligibility facts', async () => {
    await expect(prisma.studentStatus.create({ data: { studentId, semesterId, feesPaidPercent: new Prisma.Decimal(140) } })).rejects.toThrow(/student_status_percent_range/);
    await expect(prisma.studentStatus.create({ data: { studentId, semesterId, libraryFinesUgx: -5 } })).rejects.toThrow(/student_status_nonneg/);
  });

  it('allows one active hostel allocation per student', async () => {
    const venue = await prisma.venue.create({ data: { code: `H-${hex(3)}`, name: 'Hostel venue', kind: 'HOSTEL' } });
    const hostel = await prisma.hostel.create({ data: { code: `HS${hex(3)}`, name: 'H', venueId: venue.id } });
    await prisma.hostelAllocation.create({ data: { studentId, hostelId: hostel.id } });
    await expect(prisma.hostelAllocation.create({ data: { studentId, hostelId: hostel.id } })).rejects.toThrow(/hostel_allocations_one_active_per_student|Unique constraint/);
    await expect(prisma.hostelAllocation.create({ data: { studentId, hostelId: hostel.id, active: false } })).resolves.toBeDefined();
  });

  it('treats access logs as immutable', async () => {
    const log = await prisma.accessLog.create({ data: { authMethod: 'QR', decision: 'DENY', reasonCode: 'CARD_UNKNOWN', message: 'test' } });
    await expect(prisma.accessLog.update({ where: { id: log.id }, data: { decision: 'GRANT' } })).rejects.toThrow(/immutable/);
    await expect(prisma.accessLog.delete({ where: { id: log.id } })).resolves.toBeDefined(); // retention purge is allowed
  });
});
