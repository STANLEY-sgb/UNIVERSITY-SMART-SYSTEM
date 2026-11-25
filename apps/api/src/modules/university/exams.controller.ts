import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

class SessionDto {
  @ApiProperty() @IsString() @MaxLength(20) courseCode!: string;
  @ApiProperty() @IsString() @MaxLength(40) venueCode!: string;
  @ApiProperty({ example: '2026-12-01T09:00:00+03:00' }) @IsISO8601({ strict: true }) startsAt!: string;
  @ApiProperty({ example: '2026-12-01T12:00:00+03:00' }) @IsISO8601({ strict: true }) endsAt!: string;
  @ApiPropertyOptional({ default: 60, description: 'Minutes before the start that entry opens' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(240) entryOpensMinutesBefore?: number;
  @ApiPropertyOptional({ default: 30, description: 'Minutes after the start that entry closes' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(240) entryClosesMinutesAfter?: number;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class SeatDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty({ example: 'B12' }) @Matches(/^[A-Z][0-9]{1,3}$/) seatLabel!: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
const SEATS_PER_ROW = 20;
/** A1..A20, B1..B20, ... */
const seatLabel = (i: number) => `${String.fromCharCode(65 + Math.floor(i / SEATS_PER_ROW))}${(i % SEATS_PER_ROW) + 1}`;
class CancelDto { @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string }
class SessionsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['upcoming', 'past', 'all'] })
  @IsOptional() @IsEnum({ upcoming: 'upcoming', past: 'past', all: 'all' }) when?: 'upcoming' | 'past' | 'all';
}

const MIN = 60_000;

@ApiTags('exams')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class ExamsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @RequirePermissions('exams.view')
  @Get('exams/halls')
  halls() {
    return this.prisma.venue.findMany({ where: { kind: 'EXAM_HALL' }, orderBy: { code: 'asc' }, select: { code: true, name: true, capacity: true } });
  }

  @RequirePermissions('exams.view')
  @Get('exams/sessions')
  async sessions(@Query() q: SessionsQuery) {
    const now = new Date();
    const when = q.when ?? 'upcoming';
    const where: Prisma.ExamSessionWhereInput = when === 'all' ? {} : when === 'past' ? { endsAt: { lt: now } } : { endsAt: { gte: now } };
    const [total, rows] = await Promise.all([
      this.prisma.examSession.count({ where }),
      this.prisma.examSession.findMany({
        where, orderBy: { startsAt: when === 'past' ? 'desc' : 'asc' }, skip: q.skip, take: q.pageSize,
        select: {
          id: true, startsAt: true, endsAt: true, entryOpensAt: true, entryClosesAt: true,
          courseUnit: { select: { code: true, title: true } }, venue: { select: { code: true, name: true, capacity: true } },
          semester: { select: { number: true, session: { select: { code: true } } } },
          _count: { select: { attendance: true, seats: true } },
        },
      }),
    ]);
    return paged(rows.map((r) => ({
      id: r.id, courseCode: r.courseUnit.code, courseTitle: r.courseUnit.title, venueCode: r.venue.code, venueName: r.venue.name, capacity: r.venue.capacity,
      startsAt: r.startsAt, endsAt: r.endsAt, entryOpensAt: r.entryOpensAt, entryClosesAt: r.entryClosesAt,
      semester: `${r.semester.session.code} S${r.semester.number}`, attendanceCount: r._count.attendance, seatCount: r._count.seats,
    })), total, q);
  }

  @RequirePermissions('exams.manage')
  @Post('exams/sessions')
  async create(@Body() dto: SessionDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const startsAt = new Date(dto.startsAt), endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw new ConflictException({ code: 'INVALID_WINDOW', message: 'The examination must end after it starts' });
    if (endsAt.getTime() - startsAt.getTime() > 12 * 60 * MIN) throw new ConflictException({ code: 'INVALID_WINDOW', message: 'An examination cannot run longer than 12 hours' });
    const opens = new Date(startsAt.getTime() - (dto.entryOpensMinutesBefore ?? 60) * MIN);
    const closes = new Date(startsAt.getTime() + (dto.entryClosesMinutesAfter ?? 30) * MIN);
    const [cu, venue, semester] = await Promise.all([
      this.prisma.courseUnit.findUnique({ where: { code: dto.courseCode } }),
      this.prisma.venue.findUnique({ where: { code: dto.venueCode } }),
      this.prisma.semester.findFirst({ where: { isCurrent: true } }),
    ]);
    if (!cu) throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course unit not found' });
    if (!venue) throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found' });
    if (venue.kind !== 'EXAM_HALL') throw new ConflictException({ code: 'NOT_EXAM_HALL', message: 'That venue is not an examination hall' });
    if (!semester) throw new ConflictException({ code: 'NO_CURRENT_SEMESTER', message: 'There is no current semester to schedule into' });
    if ((await this.prisma.examSession.count({ where: { courseUnitId: cu.id, semesterId: semester.id } })) > 0) {
      throw new ConflictException({ code: 'ALREADY_SCHEDULED', message: 'This course already has an examination this semester' });
    }
    const clash = await this.prisma.examSession.findFirst({ where: { venueId: venue.id, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } }, include: { courseUnit: true } });
    if (clash) throw new ConflictException({ code: 'VENUE_CLASH', message: `${venue.name} is already used by ${clash.courseUnit.code} at that time` });
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.examSession.create({ data: { courseUnitId: cu.id, semesterId: semester.id, venueId: venue.id, startsAt, endsAt, entryOpensAt: opens, entryClosesAt: closes }, select: { id: true } });
      await this.audit.record({
        actorId: u.id, action: 'exams.session_created', entityType: 'ExamSession', entityId: e.id,
        after: { course: cu.code, venue: venue.code, startsAt, endsAt, entryOpensAt: opens, entryClosesAt: closes }, reason: dto.reason, requestMeta: meta,
      }, tx);
      return { id: e.id, entryOpensAt: opens, entryClosesAt: closes };
    });
  }

  @RequirePermissions('exams.manage')
  @Post('exams/sessions/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const e = await this.prisma.examSession.findUnique({ where: { id }, include: { courseUnit: true, venue: true } });
    if (!e) throw new NotFoundException({ code: 'EXAM_NOT_FOUND', message: 'Examination not found' });
    if ((await this.prisma.examAttendance.count({ where: { examSessionId: id } })) > 0) {
      throw new ConflictException({ code: 'HAS_ATTENDANCE', message: 'Attendance was already recorded, so this examination cannot be cancelled' });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.examSession.delete({ where: { id } });
      await this.audit.record({
        actorId: u.id, action: 'exams.session_cancelled', entityType: 'ExamSession', entityId: id,
        before: { course: e.courseUnit.code, venue: e.venue.code, startsAt: e.startsAt, endsAt: e.endsAt }, reason: dto.reason, requestMeta: meta,
      }, tx);
      return { id, cancelled: true };
    });
  }

  @RequirePermissions('exams.attendance.view')
  @Get('exams/sessions/:id/attendance')
  async attendance(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    const e = await this.prisma.examSession.findUnique({ where: { id }, select: { id: true, courseUnit: { select: { code: true, title: true } } } });
    if (!e) throw new NotFoundException({ code: 'EXAM_NOT_FOUND', message: 'Examination not found' });
    const [total, rows] = await Promise.all([
      this.prisma.examAttendance.count({ where: { examSessionId: id } }),
      this.prisma.examAttendance.findMany({
        where: { examSessionId: id }, orderBy: { markedAt: 'asc' }, skip: q.skip, take: q.pageSize,
        select: { id: true, status: true, markedAt: true, student: { select: { regNo: true, fullName: true } } },
      }),
    ]);
    return { course: e.courseUnit, ...paged(rows.map((r) => ({ id: r.id, regNo: r.student.regNo, fullName: r.student.fullName, status: r.status, markedAt: r.markedAt })), total, q) };
  }

  // ───────────────────────── seating ─────────────────────────

  @RequirePermissions('exams.view')
  @Get('exams/sessions/:id/seats')
  async seats(@Param('id', ParseUUIDPipe) id: string) {
    const e = await this.prisma.examSession.findUnique({ where: { id }, select: { id: true, venue: { select: { capacity: true, name: true } }, courseUnitId: true, semesterId: true, courseUnit: { select: { code: true } } } });
    if (!e) throw new NotFoundException({ code: 'EXAM_NOT_FOUND', message: 'Examination not found' });
    const [seats, enrolled] = await Promise.all([
      this.prisma.examSeat.findMany({ where: { examSessionId: id } }),
      this.prisma.enrolment.count({ where: { courseUnitId: e.courseUnitId, semesterId: e.semesterId } }),
    ]);
    const students = await this.prisma.student.findMany({ where: { id: { in: seats.map((x) => x.studentId) } }, select: { id: true, regNo: true, fullName: true } });
    const by = new Map(students.map((x) => [x.id, x]));
    const rows = seats.map((x) => ({ id: x.id, seatLabel: x.seatLabel, regNo: by.get(x.studentId)?.regNo ?? '', fullName: by.get(x.studentId)?.fullName ?? '' }))
      .sort((a, b) => a.seatLabel.length - b.seatLabel.length || a.seatLabel.localeCompare(b.seatLabel));
    return { course: e.courseUnit.code, venue: e.venue.name, capacity: e.venue.capacity, enrolled, seated: seats.length, unseated: Math.max(0, enrolled - seats.length), data: rows };
  }

  /** Seats every enrolled student who has no seat yet, in registration-number order, filling the first free labels. */
  @RequirePermissions('exams.manage')
  @Post('exams/sessions/:id/seats/auto-assign')
  @HttpCode(200)
  async autoAssign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const e = await this.prisma.examSession.findUnique({ where: { id }, include: { venue: true, courseUnit: true } });
    if (!e) throw new NotFoundException({ code: 'EXAM_NOT_FOUND', message: 'Examination not found' });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [taken, enrolled] = await Promise.all([
        tx.examSeat.findMany({ where: { examSessionId: id }, select: { studentId: true, seatLabel: true } }),
        tx.enrolment.findMany({ where: { courseUnitId: e.courseUnitId, semesterId: e.semesterId, student: { accountStatus: 'ACTIVE', deletedAt: null } }, select: { student: { select: { id: true, regNo: true } } } }),
      ]);
      const seated = new Set(taken.map((x) => x.studentId)), used = new Set(taken.map((x) => x.seatLabel));
      const todo = enrolled.map((x) => x.student).filter((s) => !seated.has(s.id)).sort((a, b) => a.regNo.localeCompare(b.regNo));
      if (!todo.length) throw new ConflictException({ code: 'NOTHING_TO_ASSIGN', message: 'Every enrolled student already has a seat' });
      const cap = e.venue.capacity ?? Infinity;
      if (taken.length + todo.length > cap) throw new ConflictException({ code: 'OVER_CAPACITY', message: `${e.venue.name} seats ${cap}, but ${taken.length + todo.length} students need a seat` });
      let n = 0;
      const rows: { examSessionId: string; studentId: string; seatLabel: string }[] = [];
      for (const s of todo) { while (used.has(seatLabel(n))) n++; rows.push({ examSessionId: id, studentId: s.id, seatLabel: seatLabel(n) }); used.add(seatLabel(n)); }
      await tx.examSeat.createMany({ data: rows });
      await this.audit.record({ actorId: u.id, action: 'exams.seats_assigned', entityType: 'ExamSession', entityId: id, after: { course: e.courseUnit.code, assigned: rows.length }, reason: dto.reason, requestMeta: meta }, tx);
      return { assigned: rows.length };
    });
  }

  @RequirePermissions('exams.manage')
  @Post('exams/sessions/:id/seats')
  async setSeat(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SeatDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const e = await this.prisma.examSession.findUnique({ where: { id }, include: { courseUnit: true, venue: true } });
    if (!e) throw new NotFoundException({ code: 'EXAM_NOT_FOUND', message: 'Examination not found' });
    const student = await this.prisma.student.findFirst({ where: { regNo: dto.regNo, deletedAt: null } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    if (!(await this.prisma.enrolment.count({ where: { studentId: student.id, courseUnitId: e.courseUnitId, semesterId: e.semesterId } }))) {
      throw new ConflictException({ code: 'NOT_ENROLLED', message: 'This student is not enrolled in the course' });
    }
    const holder = await this.prisma.examSeat.findFirst({ where: { examSessionId: id, seatLabel: dto.seatLabel } });
    if (holder && holder.studentId !== student.id) throw new ConflictException({ code: 'SEAT_TAKEN', message: `Seat ${dto.seatLabel} is already taken` });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const prev = await tx.examSeat.findUnique({ where: { examSessionId_studentId: { examSessionId: id, studentId: student.id } } });
        const seat = await tx.examSeat.upsert({ where: { examSessionId_studentId: { examSessionId: id, studentId: student.id } }, update: { seatLabel: dto.seatLabel }, create: { examSessionId: id, studentId: student.id, seatLabel: dto.seatLabel } });
        await this.audit.record({ actorId: u.id, action: 'exams.seat_set', entityType: 'ExamSession', entityId: id, before: prev ? { seatLabel: prev.seatLabel } : null, after: { regNo: student.regNo, seatLabel: dto.seatLabel, course: e.courseUnit.code }, reason: dto.reason, requestMeta: meta }, tx);
        return { id: seat.id, seatLabel: seat.seatLabel };
      });
    } catch (x) {
      if ((x as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'SEAT_TAKEN', message: `Seat ${dto.seatLabel} is already taken` });
      throw x;
    }
  }
}
