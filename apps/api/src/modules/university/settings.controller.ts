import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_POLICY, FactsService } from '../access/facts.service';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const KINDS = ['GATE', 'LIBRARY', 'EXAM_HALL', 'LECTURE_ROOM', 'HOSTEL', 'CAFETERIA', 'LAB', 'HEALTH', 'OTHER'] as const;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

class PolicyDto {
  @ApiPropertyOptional({ description: 'Library fines (UGX) above which borrowing is refused' }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) fine_limit_ugx?: number;
  @ApiPropertyOptional({ description: 'Minimum % of fees paid for examination clearance' }) @IsOptional() @IsNumber() @Min(0) @Max(100) exam_min_fees_percent?: number;
  @ApiPropertyOptional({ description: 'When true, gate readers must send ENTRY/EXIT' }) @IsOptional() @IsBoolean() gate_direction_required?: boolean;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class VenueDto {
  @ApiProperty() @Matches(/^[A-Z0-9][A-Z0-9-]{1,31}$/) code!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS as unknown as string[]) kind!: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @Matches(HHMM) opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HHMM) closesAt?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class VenuePatchDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) capacity?: number;
  @ApiPropertyOptional() @IsOptional() @Matches(HHMM) opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(HHMM) closesAt?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class SessionDto {
  @ApiProperty({ example: '2027/2028' }) @Matches(/^\d{4}\/\d{4}$/) code!: string;
  @ApiProperty() @IsDateString({ strict: true }) startsOn!: string;
  @ApiProperty() @IsDateString({ strict: true }) endsOn!: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class SemesterDto {
  @ApiProperty({ minimum: 1, maximum: 3 }) @Type(() => Number) @IsInt() @Min(1) @Max(3) number!: number;
  @ApiProperty() @IsDateString({ strict: true }) startsOn!: string;
  @ApiProperty() @IsDateString({ strict: true }) endsOn!: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
}
class ReasonDto { @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string }

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Institutional configuration: policy values, venues, academic calendar. Everything is audited with a reason. */
@ApiTags('settings')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly facts: FactsService) {}

  // ───────────────────────── policy (placeholder values KIU must confirm) ─────────────────────────

  @RequirePermissions('settings.manage')
  @Get('policy')
  async policy() { return { values: await this.facts.policy(), defaults: DEFAULT_POLICY }; }

  @RequirePermissions('settings.manage')
  @Patch('policy')
  async setPolicy(@Body() dto: PolicyDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const { reason, ...patch } = dto;
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(changes).length) throw new ConflictException({ code: 'NOTHING_TO_CHANGE', message: 'Choose at least one value to change' });
    const before = await this.facts.policy();
    const next = { ...before, ...changes };
    return this.prisma.$transaction(async (tx) => {
      await tx.systemSetting.upsert({ where: { key: 'policy' }, update: { value: next as Prisma.InputJsonValue, updatedBy: u.id }, create: { key: 'policy', value: next as Prisma.InputJsonValue, updatedBy: u.id } });
      await this.audit.record({ actorId: u.id, action: 'settings.policy_changed', entityType: 'SystemSetting', entityId: 'policy', before, after: next, reason, requestMeta: meta }, tx);
      return { values: next, defaults: DEFAULT_POLICY };
    });
  }

  // ───────────────────────── venues ─────────────────────────

  @RequirePermissions('settings.manage')
  @Get('venues')
  venues() {
    return this.prisma.venue.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, kind: true, capacity: true, opensAt: true, closesAt: true, _count: { select: { readers: true } } } })
      .then((rows) => rows.map(({ _count, ...v }) => ({ ...v, readers: _count.readers })));
  }

  private checkHours(opens?: string | null, closes?: string | null) {
    if ((opens && !closes) || (!opens && closes)) throw new ConflictException({ code: 'INVALID_HOURS', message: 'Give both opening and closing times, or neither' });
    if (opens && closes && toMin(opens) >= toMin(closes)) throw new ConflictException({ code: 'INVALID_HOURS', message: 'Closing time must be after opening time' });
  }

  @RequirePermissions('settings.manage')
  @Post('venues')
  async addVenue(@Body() dto: VenueDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    this.checkHours(dto.opensAt, dto.closesAt);
    if (await this.prisma.venue.findUnique({ where: { code: dto.code } })) throw new ConflictException({ code: 'VENUE_EXISTS', message: 'A venue with this code already exists' });
    const { reason, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.venue.create({ data, select: { id: true, code: true } });
      await this.audit.record({ actorId: u.id, action: 'settings.venue_added', entityType: 'Venue', entityId: v.id, after: data, reason, requestMeta: meta }, tx);
      return v;
    });
  }

  @RequirePermissions('settings.manage')
  @Patch('venues/:code')
  async editVenue(@Param('code') code: string, @Body() dto: VenuePatchDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const v = await this.prisma.venue.findUnique({ where: { code } });
    if (!v) throw new NotFoundException({ code: 'VENUE_NOT_FOUND', message: 'Venue not found' });
    const { reason, ...patch } = dto;
    const data = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined));
    this.checkHours((data.opensAt as string | undefined) ?? v.opensAt, (data.closesAt as string | undefined) ?? v.closesAt);
    return this.prisma.$transaction(async (tx) => {
      await tx.venue.update({ where: { id: v.id }, data });
      await this.audit.record({ actorId: u.id, action: 'settings.venue_edited', entityType: 'Venue', entityId: v.id, before: { name: v.name, capacity: v.capacity, opensAt: v.opensAt, closesAt: v.closesAt }, after: data, reason, requestMeta: meta }, tx);
      return { code, updated: true };
    });
  }

  // ───────────────────────── academic calendar ─────────────────────────

  @RequirePermissions('settings.manage')
  @Get('sessions')
  async sessions() {
    const rows = await this.prisma.academicSession.findMany({ orderBy: { startsOn: 'desc' }, include: { semesters: { orderBy: { number: 'asc' } } } });
    return rows.map((s) => ({
      id: s.id, code: s.code, startsOn: iso(s.startsOn), endsOn: iso(s.endsOn), isCurrent: s.isCurrent,
      semesters: s.semesters.map((m) => ({ id: m.id, number: m.number, startsOn: iso(m.startsOn), endsOn: iso(m.endsOn), isCurrent: m.isCurrent })),
    }));
  }

  @RequirePermissions('settings.manage')
  @Post('sessions')
  async addSession(@Body() dto: SessionDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const [a, b] = [day(dto.startsOn), day(dto.endsOn)];
    if (b <= a) throw new ConflictException({ code: 'INVALID_DATES', message: 'The session must end after it starts' });
    if (await this.prisma.academicSession.findUnique({ where: { code: dto.code } })) throw new ConflictException({ code: 'SESSION_EXISTS', message: 'This academic session already exists' });
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.academicSession.create({ data: { code: dto.code, startsOn: a, endsOn: b }, select: { id: true } });
      await this.audit.record({ actorId: u.id, action: 'settings.session_added', entityType: 'AcademicSession', entityId: s.id, after: { code: dto.code, startsOn: dto.startsOn, endsOn: dto.endsOn }, reason: dto.reason, requestMeta: meta }, tx);
      return s;
    });
  }

  @RequirePermissions('settings.manage')
  @Post('sessions/:id/semesters')
  async addSemester(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SemesterDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const session = await this.prisma.academicSession.findUnique({ where: { id } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Academic session not found' });
    const [a, b] = [day(dto.startsOn), day(dto.endsOn)];
    if (b <= a) throw new ConflictException({ code: 'INVALID_DATES', message: 'The semester must end after it starts' });
    if (a < session.startsOn || b > session.endsOn) throw new ConflictException({ code: 'OUTSIDE_SESSION', message: 'The semester must fall inside its academic session' });
    if (await this.prisma.semester.findFirst({ where: { sessionId: id, number: dto.number } })) throw new ConflictException({ code: 'SEMESTER_EXISTS', message: 'That semester number already exists in this session' });
    const clash = await this.prisma.semester.findFirst({ where: { sessionId: id, startsOn: { lte: b }, endsOn: { gte: a } } });
    if (clash) throw new ConflictException({ code: 'SEMESTER_OVERLAP', message: `Overlaps semester ${clash.number}` });
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.semester.create({ data: { sessionId: id, number: dto.number, startsOn: a, endsOn: b }, select: { id: true } });
      await this.audit.record({ actorId: u.id, action: 'settings.semester_added', entityType: 'Semester', entityId: m.id, after: { session: session.code, number: dto.number, startsOn: dto.startsOn, endsOn: dto.endsOn }, reason: dto.reason, requestMeta: meta }, tx);
      return m;
    });
  }

  /** Exactly one current semester (and its session). Eligibility, exam scheduling and registration read it. */
  @RequirePermissions('settings.manage')
  @Post('semesters/:id/make-current')
  @HttpCode(200)
  async makeCurrent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const m = await this.prisma.semester.findUnique({ where: { id }, include: { session: true } });
    if (!m) throw new NotFoundException({ code: 'SEMESTER_NOT_FOUND', message: 'Semester not found' });
    if (m.isCurrent) throw new ConflictException({ code: 'ALREADY_CURRENT', message: 'This is already the current semester' });
    const prev = await this.prisma.semester.findFirst({ where: { isCurrent: true }, include: { session: true } });
    return this.prisma.$transaction(async (tx) => {
      await tx.semester.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      await tx.semester.update({ where: { id }, data: { isCurrent: true } });
      await tx.academicSession.update({ where: { id: m.sessionId }, data: { isCurrent: true } });
      await this.audit.record({
        actorId: u.id, action: 'settings.semester_made_current', entityType: 'Semester', entityId: id,
        before: prev ? { session: prev.session.code, number: prev.number } : null, after: { session: m.session.code, number: m.number }, reason: dto.reason, requestMeta: meta,
      }, tx);
      return { id, current: true };
    });
  }
}
