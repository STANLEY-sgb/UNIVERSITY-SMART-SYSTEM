import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

class AllocationDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty({ example: 'HA' }) @IsString() @MaxLength(20) hostelCode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) roomNo?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class EndDto { @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string }
class SittingDto {
  @ApiProperty({ example: '12:00' }) @Matches(HHMM) startsAt!: string;
  @ApiProperty({ example: '14:30' }) @Matches(HHMM) endsAt!: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class LectureDto {
  @ApiProperty() @IsString() @MaxLength(20) courseCode!: string;
  @ApiProperty() @IsString() @MaxLength(40) venueCode!: string;
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = Sunday' }) @Type(() => Number) @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @ApiProperty() @Matches(HHMM) startsAt!: string;
  @ApiProperty() @Matches(HHMM) endsAt!: string;
}
class AllocQuery extends PageQuery { @IsOptional() @IsString() @MaxLength(20) hostel?: string; @IsOptional() @IsString() @MaxLength(32) regNo?: string }
class DepartmentDto {
  @ApiProperty({ example: 'CS' }) @IsString() @MinLength(2) @MaxLength(20) code!: string;
  @ApiProperty({ example: 'Computer Science' }) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty({ example: 'Science & Technology' }) @IsString() @MinLength(2) @MaxLength(120) faculty!: string;
}
class ProgrammeDto {
  @ApiProperty({ example: 'BCS' }) @IsString() @MinLength(2) @MaxLength(20) code!: string;
  @ApiProperty({ example: 'BSc Computer Science' }) @IsString() @MinLength(2) @MaxLength(160) name!: string;
  @ApiProperty({ example: 'CS' }) @IsString() @MaxLength(20) departmentCode!: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 8, default: 3 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(8) durationYears?: number;
}

@ApiTags('campus')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class CampusController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  // ───────────────────────── Academic structure ─────────────────────────

  @RequirePermissions('registry.view')
  @Get('departments')
  async departments() {
    const rows = await this.prisma.department.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, faculty: true, _count: { select: { programmes: true } } } });
    return rows.map((d) => ({ id: d.id, code: d.code, name: d.name, faculty: d.faculty, programmes: d._count.programmes }));
  }

  @RequirePermissions('registry.manage')
  @Post('departments')
  async addDepartment(@Body() dto: DepartmentDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const code = dto.code.trim().toUpperCase();
    if (await this.prisma.department.findUnique({ where: { code } })) throw new ConflictException({ code: 'DEPARTMENT_EXISTS', message: `A department with code ${code} already exists` });
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.department.create({ data: { code, name: dto.name.trim(), faculty: dto.faculty.trim() }, select: { id: true, code: true, name: true, faculty: true } });
      await this.audit.record({ actorId: u.id, action: 'registry.department_created', entityType: 'Department', entityId: d.id, after: d, requestMeta: meta }, tx);
      return d;
    });
  }

  @RequirePermissions('registry.manage')
  @Post('programmes')
  async addProgramme(@Body() dto: ProgrammeDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const code = dto.code.trim().toUpperCase();
    const department = await this.prisma.department.findUnique({ where: { code: dto.departmentCode.trim().toUpperCase() } });
    if (!department) throw new NotFoundException({ code: 'DEPARTMENT_NOT_FOUND', message: 'Department not found. Create it first.' });
    if (await this.prisma.programme.findUnique({ where: { code } })) throw new ConflictException({ code: 'PROGRAMME_EXISTS', message: `A programme with code ${code} already exists` });
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.programme.create({
        data: { code, name: dto.name.trim(), departmentId: department.id, ...(dto.durationYears ? { durationYears: dto.durationYears } : {}) },
        select: { id: true, code: true, name: true, durationYears: true },
      });
      await this.audit.record({ actorId: u.id, action: 'registry.programme_created', entityType: 'Programme', entityId: p.id, after: { ...p, departmentCode: department.code }, requestMeta: meta }, tx);
      return { ...p, departmentCode: department.code };
    });
  }

  // ───────────────────────── Hostels ─────────────────────────

  @RequirePermissions('hostel.view')
  @Get('hostels')
  hostels() {
    return this.prisma.hostel.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, venue: { select: { code: true } }, _count: { select: { allocations: { where: { active: true } } } } } })
      .then((rows) => rows.map((h) => ({ id: h.id, code: h.code, name: h.name, venueCode: h.venue.code, residents: h._count.allocations })));
  }

  @RequirePermissions('hostel.view')
  @Get('hostels/allocations')
  async allocations(@Query() q: AllocQuery) {
    const where: Prisma.HostelAllocationWhereInput = { active: true, ...(q.hostel ? { hostel: { code: q.hostel } } : {}), ...(q.regNo ? { student: { regNo: { contains: q.regNo.toUpperCase() } } } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.hostelAllocation.findMany({ where, orderBy: { allocatedAt: 'desc' }, skip: q.skip, take: q.pageSize, select: { id: true, roomNo: true, allocatedAt: true, hostel: { select: { code: true, name: true } }, student: { select: { regNo: true, fullName: true } } } }),
      this.prisma.hostelAllocation.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  /** Allocating replaces any current allocation, so a student is only ever admitted to one hostel. */
  @RequirePermissions('hostel.manage')
  @Post('hostels/allocations')
  async allocate(@Body() dto: AllocationDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const student = await this.prisma.student.findFirst({ where: { regNo: dto.regNo.toUpperCase(), deletedAt: null } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    const hostel = await this.prisma.hostel.findUnique({ where: { code: dto.hostelCode } });
    if (!hostel) throw new NotFoundException({ code: 'HOSTEL_NOT_FOUND', message: 'Hostel not found' });
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.hostelAllocation.findMany({ where: { studentId: student.id, active: true }, include: { hostel: true } });
      await tx.hostelAllocation.updateMany({ where: { studentId: student.id, active: true }, data: { active: false } });
      const a = await tx.hostelAllocation.create({ data: { studentId: student.id, hostelId: hostel.id, roomNo: dto.roomNo ?? null, semesterId: semester?.id ?? null }, select: { id: true, roomNo: true } });
      await this.audit.record({ actorId: u.id, action: 'hostel.allocate', entityType: 'HostelAllocation', entityId: a.id, before: { hostels: previous.map((p) => p.hostel.code) }, after: { regNo: student.regNo, hostel: hostel.code, roomNo: a.roomNo }, reason: dto.reason, requestMeta: meta }, tx);
      await tx.studentStatus.updateMany({ where: { studentId: student.id, semesterId: semester?.id ?? '' }, data: { factsVersion: { increment: 1 } } });
      return { id: a.id, regNo: student.regNo, hostel: hostel.code, roomNo: a.roomNo };
    });
  }

  @RequirePermissions('hostel.manage')
  @Post('hostels/allocations/:id/end')
  @HttpCode(200)
  async endAllocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const a = await this.prisma.hostelAllocation.findUnique({ where: { id }, include: { hostel: true, student: true } });
    if (!a) throw new NotFoundException({ code: 'ALLOCATION_NOT_FOUND', message: 'Allocation not found' });
    if (!a.active) throw new ConflictException({ code: 'ALREADY_ENDED', message: 'This allocation has already ended' });
    return this.prisma.$transaction(async (tx) => {
      await tx.hostelAllocation.update({ where: { id }, data: { active: false } });
      await this.audit.record({ actorId: u.id, action: 'hostel.allocation_ended', entityType: 'HostelAllocation', entityId: id, before: { regNo: a.student.regNo, hostel: a.hostel.code, active: true }, after: { active: false }, reason: dto.reason, requestMeta: meta }, tx);
      return { id, active: false };
    });
  }

  // ───────────────────────── Cafeteria ─────────────────────────

  @RequirePermissions('cafeteria.view')
  @Get('cafeteria/sittings')
  sittings() {
    return this.prisma.mealSitting.findMany({ where: { service: { code: 'CAFETERIA' } }, orderBy: { startsAt: 'asc' }, select: { id: true, mealType: true, startsAt: true, endsAt: true } });
  }

  @RequirePermissions('cafeteria.manage')
  @Patch('cafeteria/sittings/:id')
  async setSitting(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SittingDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    if (toMin(dto.startsAt) >= toMin(dto.endsAt)) throw new ConflictException({ code: 'INVALID_WINDOW', message: 'The sitting must end after it starts' });
    const s = await this.prisma.mealSitting.findUnique({ where: { id } });
    if (!s) throw new NotFoundException({ code: 'SITTING_NOT_FOUND', message: 'Sitting not found' });
    const others = await this.prisma.mealSitting.findMany({ where: { serviceId: s.serviceId, NOT: { id } } });
    const clash = others.find((o) => toMin(dto.startsAt) < toMin(o.endsAt) && toMin(o.startsAt) < toMin(dto.endsAt));
    if (clash) throw new ConflictException({ code: 'SITTING_OVERLAP', message: `Overlaps the ${clash.mealType.toLowerCase()} sitting (${clash.startsAt}–${clash.endsAt})` });
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.mealSitting.update({ where: { id }, data: { startsAt: dto.startsAt, endsAt: dto.endsAt }, select: { id: true, mealType: true, startsAt: true, endsAt: true } });
      await this.audit.record({ actorId: u.id, action: 'cafeteria.sitting_update', entityType: 'MealSitting', entityId: id, before: { startsAt: s.startsAt, endsAt: s.endsAt }, after: { startsAt: next.startsAt, endsAt: next.endsAt }, reason: dto.reason, requestMeta: meta }, tx);
      return next;
    });
  }

  // ───────────────────────── Lecture timetable ─────────────────────────

  @RequirePermissions('registry.view')
  @Get('lectures')
  async lectures() {
    const rows = await this.prisma.lectureSchedule.findMany({ orderBy: [{ dayOfWeek: 'asc' }, { startsAt: 'asc' }], select: { id: true, dayOfWeek: true, startsAt: true, endsAt: true, courseUnit: { select: { code: true, title: true } }, venue: { select: { code: true, name: true } } } });
    return rows.map((r) => ({ id: r.id, dayOfWeek: r.dayOfWeek, startsAt: r.startsAt, endsAt: r.endsAt, courseCode: r.courseUnit.code, courseTitle: r.courseUnit.title, venueCode: r.venue.code, venueName: r.venue.name }));
  }

  @RequirePermissions('registry.manage')
  @Post('lectures')
  async addLecture(@Body() dto: LectureDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    if (toMin(dto.startsAt) >= toMin(dto.endsAt)) throw new ConflictException({ code: 'INVALID_WINDOW', message: 'The lecture must end after it starts' });
    const [cu, venue] = await Promise.all([this.prisma.courseUnit.findUnique({ where: { code: dto.courseCode } }), this.prisma.venue.findUnique({ where: { code: dto.venueCode } })]);
    if (!cu) throw new NotFoundException({ code: 'COURSE_NOT_FOUND', message: 'Course unit not found' });
    if (!venue) throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found' });
    const sameRoom = await this.prisma.lectureSchedule.findMany({ where: { venueId: venue.id, dayOfWeek: dto.dayOfWeek } });
    if (sameRoom.some((o) => toMin(dto.startsAt) < toMin(o.endsAt) && toMin(o.startsAt) < toMin(dto.endsAt))) {
      throw new ConflictException({ code: 'ROOM_CLASH', message: 'Another lecture already uses this room at that time' });
    }
    return this.prisma.$transaction(async (tx) => {
      const l = await tx.lectureSchedule.create({ data: { courseUnitId: cu.id, venueId: venue.id, dayOfWeek: dto.dayOfWeek, startsAt: dto.startsAt, endsAt: dto.endsAt }, select: { id: true } });
      await this.audit.record({ actorId: u.id, action: 'registry.lecture_added', entityType: 'LectureSchedule', entityId: l.id, after: dto, requestMeta: meta }, tx);
      return { id: l.id };
    });
  }

  @RequirePermissions('registry.manage')
  @Post('lectures/:id/remove')
  @HttpCode(200)
  async removeLecture(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const l = await this.prisma.lectureSchedule.findUnique({ where: { id }, include: { courseUnit: true, venue: true } });
    if (!l) throw new NotFoundException({ code: 'LECTURE_NOT_FOUND', message: 'Lecture not found' });
    if ((await this.prisma.lectureAttendance.count({ where: { scheduleId: id } })) > 0) {
      throw new ConflictException({ code: 'HAS_ATTENDANCE', message: 'Attendance was already recorded for this lecture, so it cannot be removed' });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.lectureSchedule.delete({ where: { id } });
      await this.audit.record({ actorId: u.id, action: 'registry.lecture_removed', entityType: 'LectureSchedule', entityId: id, before: { course: l.courseUnit.code, venue: l.venue.code, dayOfWeek: l.dayOfWeek, startsAt: l.startsAt, endsAt: l.endsAt }, reason: dto.reason, requestMeta: meta }, tx);
      return { id, removed: true };
    });
  }
}
