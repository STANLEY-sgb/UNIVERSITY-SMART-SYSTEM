import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { FactsService } from '../access/facts.service';

const ONLINE_WINDOW_MS = 2 * 60_000;

class AlertsQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional() @IsEnum({ INFO: 'INFO', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' }) severity?: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  @ApiPropertyOptional({ enum: ['open', 'acknowledged', 'all'] })
  @IsOptional() @IsEnum({ open: 'open', acknowledged: 'acknowledged', all: 'all' }) state?: 'open' | 'acknowledged' | 'all';
}
class AckDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) note?: string;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

@ApiTags('admin')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class AdminController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly facts: FactsService) {}

  /**
   * Console overview. Every number is a live query. Sections beyond the aggregates are included only when the caller
   * holds the matching permission (decisions need access.logs.view, admin actions need audit.view), so the same
   * endpoint is safe for every reporting role.
   */
  @RequirePermissions('reports.view')
  @Get('dashboard/summary')
  async summary(@CurrentUser() u: AuthUser) {
    const since = startOfToday();
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);
    const [students, cardGroups, readerGroups, readersOnline, today, byReason, byService, hourly, alerts, attendance] = await Promise.all([
      this.prisma.student.count({ where: { accountStatus: 'ACTIVE', deletedAt: null } }),
      this.prisma.card.groupBy({ by: ['status'], _count: true }),
      this.prisma.reader.groupBy({ by: ['status'], _count: true }),
      this.prisma.reader.count({ where: { status: 'ACTIVE', lastHeartbeatAt: { gte: onlineSince } } }),
      this.prisma.accessLog.groupBy({ by: ['decision', 'offline'], where: { occurredAt: { gte: since } }, _count: true }),
      this.prisma.accessLog.groupBy({ by: ['reasonCode'], where: { occurredAt: { gte: since }, decision: 'DENY' }, _count: true, orderBy: { _count: { reasonCode: 'desc' } }, take: 6 }),
      this.prisma.accessLog.groupBy({ by: ['serviceId', 'decision'], where: { occurredAt: { gte: since } }, _count: true }),
      this.prisma.$queryRaw<{ h: Date; decision: string; c: number }[]>`SELECT date_trunc('hour', occurred_at) AS h, decision::text AS decision, count(*)::int AS c FROM access_logs WHERE occurred_at >= ${since} GROUP BY 1, 2 ORDER BY 1`,
      this.prisma.securityAlert.groupBy({ by: ['severity'], where: { ackedAt: null }, _count: true }),
      this.prisma.examAttendance.count({ where: { markedAt: { gte: since } } }),
    ]);

    const serviceNames = new Map((await this.prisma.service.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
    const count = (decision: 'GRANT' | 'DENY', offline?: boolean) =>
      today.filter((t) => t.decision === decision && (offline === undefined || t.offline === offline)).reduce((n, t) => n + t._count, 0);
    const svc = new Map<string, { code: string; name: string; grants: number; denies: number }>();
    for (const r of byService) {
      const s = r.serviceId ? serviceNames.get(r.serviceId) : undefined;
      if (!s) continue;
      const row = svc.get(s.code) ?? { code: s.code, name: s.name, grants: 0, denies: 0 };
      if (r.decision === 'GRANT') row.grants += r._count; else row.denies += r._count;
      svc.set(s.code, row);
    }

    const out: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      students: { active: students },
      cards: Object.fromEntries(cardGroups.map((g) => [g.status, g._count])),
      readers: { total: readerGroups.reduce((n, g) => n + g._count, 0), active: readerGroups.find((g) => g.status === 'ACTIVE')?._count ?? 0, online: readersOnline, revoked: readerGroups.find((g) => g.status === 'REVOKED')?._count ?? 0 },
      today: { grants: count('GRANT'), denies: count('DENY'), offline: count('GRANT', true) + count('DENY', true), examAttendance: attendance },
      topDenialReasons: byReason.map((r) => ({ reason: r.reasonCode, count: r._count })),
      byService: [...svc.values()].sort((a, b) => b.grants + b.denies - (a.grants + a.denies)),
      hourly: hourly.map((h) => ({ hour: h.h.toISOString(), decision: h.decision, count: h.c })),
      openAlerts: Object.fromEntries(alerts.map((a) => [a.severity, a._count])),
    };

    if (u.permissions.includes('access.logs.view')) {
      const rows = await this.prisma.accessLog.findMany({
        orderBy: { occurredAt: 'desc' }, take: 12,
        select: { id: true, occurredAt: true, decision: true, reasonCode: true, offline: true, authMethod: true, service: { select: { name: true } }, reader: { select: { code: true } }, student: { select: { regNo: true, fullName: true } } },
      });
      out.recentDecisions = rows;
    }
    if (u.permissions.includes('audit.view')) {
      const rows = await this.prisma.auditTrail.findMany({ orderBy: { seq: 'desc' }, take: 8, select: { id: true, at: true, action: true, entityType: true, actorId: true, reason: true } });
      const actors = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter((x): x is string => !!x) } }, select: { id: true, email: true } })).map((x) => [x.id, x.email]));
      out.recentAdminActions = rows.map((r) => ({ ...r, actor: r.actorId ? actors.get(r.actorId) ?? null : null }));
    }
    return out;
  }

  // ───────────────────────── alerts ─────────────────────────

  @RequirePermissions('alerts.view')
  @Get('alerts')
  async alerts(@Query() q: AlertsQuery) {
    const state = q.state ?? 'open';
    const where: Prisma.SecurityAlertWhereInput = {
      ...(q.severity ? { severity: q.severity } : {}),
      ...(state === 'open' ? { ackedAt: null } : state === 'acknowledged' ? { ackedAt: { not: null } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.securityAlert.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize,
        select: { id: true, kind: true, severity: true, createdAt: true, ackedAt: true, detail: true, reader: { select: { code: true } }, student: { select: { regNo: true, fullName: true } } },
      }),
      this.prisma.securityAlert.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  @RequirePermissions('alerts.manage')
  @Post('alerts/:id/ack')
  @HttpCode(200)
  async ack(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AckDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const a = await this.prisma.securityAlert.findUnique({ where: { id } });
    if (!a) throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'Alert not found' });
    if (a.ackedAt) return { id, ackedAt: a.ackedAt, already: true };
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.securityAlert.update({ where: { id }, data: { ackedAt: new Date(), ackedBy: u.id }, select: { id: true, ackedAt: true } });
      await this.audit.record({ actorId: u.id, action: 'alerts.acknowledged', entityType: 'SecurityAlert', entityId: id, after: { kind: a.kind, severity: a.severity }, reason: dto.note ?? null, requestMeta: meta }, tx);
      return { ...r, already: false };
    });
  }

  // ───────────────────────── services & student overview ─────────────────────────

  @RequirePermissions('readers.view')
  @Get('venues')
  venues() {
    return this.prisma.venue.findMany({ orderBy: { code: 'asc' }, select: { code: true, name: true, kind: true } });
  }

  @RequirePermissions('students.view')
  @Get('programmes')
  async programmes() {
    const rows = await this.prisma.programme.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, durationYears: true, department: { select: { code: true } } } });
    return rows.map((p) => ({ id: p.id, code: p.code, name: p.name, durationYears: p.durationYears, departmentCode: p.department.code }));
  }

  @RequirePermissions('services.view')
  @Get('services')
  async services() {
    const rows = await this.prisma.service.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, active: true, offlinePolicy: true, sensitivity: true, rules: { select: { published: { select: { version: true, publishedAt: true } }, versions: { where: { status: 'DRAFT' }, select: { version: true } } } }, _count: { select: { readers: true } } },
    });
    return rows.map((s) => ({
      code: s.code, name: s.name, active: s.active, offlinePolicy: s.offlinePolicy, sensitivity: s.sensitivity, readers: s._count.readers,
      publishedVersion: s.rules[0]?.published?.version ?? null, publishedAt: s.rules[0]?.published?.publishedAt ?? null, hasDraft: (s.rules[0]?.versions.length ?? 0) > 0,
    }));
  }

  /**
   * One student, everything an operator needs. Eligibility facts (fees %, fines…) are financial/academic data, so they
   * are returned only to roles that manage them.
   */
  @RequirePermissions('students.view')
  @Get('students/:id/overview')
  async overview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const s = await this.prisma.student.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, regNo: true, fullName: true, email: true, phone: true, yearOfStudy: true, accountStatus: true, programme: { select: { code: true, name: true } } },
    });
    if (!s) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    const canFacts = ['finance.view', 'registry.view', 'students.update'].some((p) => u.permissions.includes(p));
    const canCards = u.permissions.includes('cards.view');
    const [cards, enrolments, loans, hostel, recent] = await Promise.all([
      canCards ? this.prisma.card.findMany({ where: { studentId: id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, cardNumber: true, status: true, issuedAt: true, expiresAt: true, replacesCardId: true } }) : [],
      this.prisma.enrolment.findMany({ where: { studentId: id, semester: { isCurrent: true } }, select: { courseUnit: { select: { code: true, title: true } } } }),
      this.prisma.libraryLoan.count({ where: { studentId: id, status: { in: ['ACTIVE', 'OVERDUE'] } } }),
      this.prisma.hostelAllocation.findFirst({ where: { studentId: id, active: true }, select: { roomNo: true, hostel: { select: { name: true } } } }),
      u.permissions.includes('access.logs.view')
        ? this.prisma.accessLog.findMany({ where: { studentId: id }, orderBy: { occurredAt: 'desc' }, take: 10, select: { id: true, occurredAt: true, decision: true, reasonCode: true, offline: true, service: { select: { name: true } } } })
        : [],
    ]);
    const facts = canFacts ? await this.facts.loadFacts(id, null) : null;
    return {
      student: s, cards: canCards ? cards : null, facts, enrolments: enrolments.map((e) => e.courseUnit), activeLoans: loans,
      hostel: hostel ? { name: hostel.hostel.name, room: hostel.roomNo } : null, recentAccess: u.permissions.includes('access.logs.view') ? recent : null,
    };
  }
}
