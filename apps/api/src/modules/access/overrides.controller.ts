import { Body, ConflictException, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** Denials that a person may never talk their way past: identity, credential, account and device problems. */
export const HARD_DENIALS = /^(CARD_|CREDENTIAL_|NONCE_|COUNTER_|READER_|BAD_|FACE_|STUDENT_SUSPENDED|SYSTEM_ERROR|MANUAL_OVERRIDE)/;
export const OVERRIDE_WINDOW_MS = 30 * 60_000;

class OverrideDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty({ example: 'EXAM' }) @IsString() @MaxLength(32) serviceCode!: string;
  @ApiPropertyOptional({ description: 'Reader the student was refused at, if known' }) @IsOptional() @IsString() @MaxLength(32) readerCode?: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(300) reason!: string;
}

/**
 * Manual override: a trusted person lets a student through after a genuine, recent rule denial. It is deliberately narrow:
 * it needs an actual denial for the same student and service in the last 30 minutes, never covers identity/credential/
 * account failures, requires a written reason, and always leaves a log row, an audit entry and a security alert.
 */
@ApiTags('overrides')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class OverridesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @RequirePermissions('access.override')
  @Post('access/overrides')
  async create(@Body() dto: OverrideDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const [student, service] = await Promise.all([
      this.prisma.student.findFirst({ where: { regNo: dto.regNo, deletedAt: null } }),
      this.prisma.service.findUnique({ where: { code: dto.serviceCode.toUpperCase() } }),
    ]);
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    if (!service) throw new NotFoundException({ code: 'SERVICE_NOT_FOUND', message: 'Service not found' });
    const reader = dto.readerCode ? await this.prisma.reader.findUnique({ where: { code: dto.readerCode } }) : null;
    if (dto.readerCode && !reader) throw new NotFoundException({ code: 'READER_NOT_FOUND', message: 'Reader not found' });

    const denial = await this.prisma.accessLog.findFirst({
      where: { studentId: student.id, serviceId: service.id, decision: 'DENY', occurredAt: { gte: new Date(Date.now() - OVERRIDE_WINDOW_MS) }, ...(reader ? { readerId: reader.id } : {}) },
      orderBy: { occurredAt: 'desc' },
    });
    if (!denial) throw new ConflictException({ code: 'NO_RECENT_DENIAL', message: 'Overrides need a refusal for this student and service in the last 30 minutes. Ask the student to scan first.' });
    if (HARD_DENIALS.test(denial.reasonCode)) throw new ConflictException({ code: 'NOT_OVERRIDABLE', message: `A refusal of type ${denial.reasonCode} cannot be overridden. Use the card office, or another credential.` });
    if (student.accountStatus !== 'ACTIVE') throw new ConflictException({ code: 'NOT_OVERRIDABLE', message: 'The student account is not active.' });
    if (await this.prisma.accessOverride.count({ where: { studentId: student.id, serviceId: service.id, createdAt: { gte: denial.occurredAt } } })) {
      throw new ConflictException({ code: 'ALREADY_OVERRIDDEN', message: 'This refusal was already overridden.' });
    }

    return this.prisma.$transaction(async (tx) => {
      const ov = await tx.accessOverride.create({ data: { studentId: student.id, serviceId: service.id, readerId: reader?.id ?? denial.readerId, actorId: u.id, reason: dto.reason, originalReasonCode: denial.reasonCode } });
      const log = await tx.accessLog.create({
        data: {
          readerId: reader?.id ?? denial.readerId, serviceId: service.id, venueId: reader?.venueId ?? denial.venueId, studentId: student.id, cardId: denial.cardId,
          authMethod: 'MANUAL_OVERRIDE', direction: denial.direction, decision: 'GRANT', reasonCode: 'MANUAL_OVERRIDE', message: `Manual override: ${denial.reasonCode}`,
          overrideId: ov.id, context: { originalReason: denial.reasonCode, originalLogId: denial.id, actorId: u.id },
        },
      });
      if (service.code === 'EXAM') {
        const now = new Date();
        const exam = await tx.examSession.findFirst({
          where: { entryOpensAt: { lte: now }, entryClosesAt: { gte: now }, courseUnit: { enrolments: { some: { studentId: student.id } } }, ...(reader ? { venueId: reader.venueId } : {}) },
          orderBy: { startsAt: 'asc' },
        });
        if (exam) await tx.examAttendance.upsert({ where: { examSessionId_studentId: { examSessionId: exam.id, studentId: student.id } }, update: {}, create: { examSessionId: exam.id, studentId: student.id, status: 'OVERRIDDEN', accessLogId: log.id } });
      }
      await tx.securityAlert.create({ data: { kind: 'MANUAL_OVERRIDE', severity: 'MEDIUM', readerId: reader?.id ?? denial.readerId, studentId: student.id, detail: { service: service.code, originalReason: denial.reasonCode, by: u.email } } });
      await this.audit.record({ actorId: u.id, action: 'access.override_granted', entityType: 'AccessOverride', entityId: ov.id, after: { regNo: student.regNo, service: service.code, originalReason: denial.reasonCode }, reason: dto.reason, requestMeta: meta }, tx);
      return { id: ov.id, logId: log.id, originalReason: denial.reasonCode };
    });
  }

  @RequirePermissions('access.logs.view')
  @Get('access/overrides')
  async list(@Query() q: PageQuery) {
    const [total, rows] = await Promise.all([
      this.prisma.accessOverride.count(),
      this.prisma.accessOverride.findMany({ orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize, include: { student: { select: { regNo: true, fullName: true } } } }),
    ]);
    const [services, actors] = await Promise.all([
      this.prisma.service.findMany({ select: { id: true, code: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorId) } }, select: { id: true, displayName: true } }),
    ]);
    const sv = new Map(services.map((s) => [s.id, s.code])), ac = new Map(actors.map((a) => [a.id, a.displayName]));
    return paged(rows.map((r) => ({ id: r.id, at: r.createdAt, regNo: r.student.regNo, fullName: r.student.fullName, service: sv.get(r.serviceId) ?? '', originalReason: r.originalReasonCode, reason: r.reason, by: ac.get(r.actorId) ?? '' })), total, q);
  }
}
