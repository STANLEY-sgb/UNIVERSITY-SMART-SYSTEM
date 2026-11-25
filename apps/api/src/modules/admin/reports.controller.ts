import { BadRequestException, Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 93;
export const EXPORT_MAX_ROWS = 10_000;

class RangeQuery {
  @ApiPropertyOptional({ example: '2026-11-01', description: 'First day (server-local), inclusive. Default: 6 days before `to`.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from?: string;
  @ApiPropertyOptional({ example: '2026-11-07', description: 'Last day (server-local), inclusive. Default: today.' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to?: string;
}

const parseDay = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d!);
  if (dt.getFullYear() !== y || dt.getMonth() !== m! - 1 || dt.getDate() !== d) throw new BadRequestException({ code: 'DATE_INVALID', message: `${s} is not a real date` });
  return dt;
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** [start, endExclusive) in server-local time, validated and bounded. */
export function resolveRange(q: RangeQuery): { start: Date; end: Date; from: string; to: string } {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const last = q.to ? parseDay(q.to) : today;
  const first = q.from ? parseDay(q.from) : new Date(last.getFullYear(), last.getMonth(), last.getDate() - 6);
  if (first > last) throw new BadRequestException({ code: 'RANGE_INVALID', message: '`from` must not be after `to`' });
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  const days = Math.round((end.getTime() - first.getTime()) / DAY_MS);
  if (days > MAX_RANGE_DAYS) throw new BadRequestException({ code: 'RANGE_TOO_LARGE', message: `Choose at most ${MAX_RANGE_DAYS} days` });
  return { start: first, end, from: dayKey(first), to: dayKey(last) };
}

/** Quote a CSV field and neutralise spreadsheet formula injection (=, +, -, @, tab, CR at the start). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@ApiTags('reports')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Aggregate access activity for a date range. Aggregates only: no personal data. */
  @RequirePermissions('reports.view')
  @Get('access')
  async access(@Query() q: RangeQuery) {
    const r = resolveRange(q);
    const where = { occurredAt: { gte: r.start, lt: r.end } };
    const [byDay, byService, byReason, byMethod, readers, total] = await Promise.all([
      this.prisma.$queryRaw<{ d: Date; decision: string; c: number }[]>`SELECT date_trunc('day', occurred_at) AS d, decision::text AS decision, count(*)::int AS c FROM access_logs WHERE occurred_at >= ${r.start} AND occurred_at < ${r.end} GROUP BY 1, 2 ORDER BY 1`,
      this.prisma.accessLog.groupBy({ by: ['serviceId', 'decision'], where, _count: true }),
      this.prisma.accessLog.groupBy({ by: ['reasonCode'], where: { ...where, decision: 'DENY' }, _count: true, orderBy: { _count: { reasonCode: 'desc' } }, take: 10 }),
      this.prisma.accessLog.groupBy({ by: ['authMethod'], where, _count: true }),
      this.prisma.accessLog.groupBy({ by: ['readerId', 'decision'], where: { ...where, readerId: { not: null } }, _count: true }),
      this.prisma.accessLog.count({ where }),
    ]);
    const services = new Map((await this.prisma.service.findMany({ select: { id: true, code: true, name: true } })).map((s) => [s.id, s]));
    const readerRows = new Map((await this.prisma.reader.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));

    const days = new Map<string, { date: string; grants: number; denies: number }>();
    for (let t = r.start.getTime(); t < r.end.getTime(); ) { const d = new Date(t); days.set(dayKey(d), { date: dayKey(d), grants: 0, denies: 0 }); t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); }
    for (const row of byDay) { const e = days.get(dayKey(row.d)); if (e) { if (row.decision === 'GRANT') e.grants += row.c; else e.denies += row.c; } }

    const tally = <K extends string>(rows: { decision: string; _count: number }[], key: (x: any) => K | null) => {
      const m = new Map<K, { grants: number; denies: number }>();
      for (const x of rows) { const k = key(x); if (k === null) continue; const e = m.get(k) ?? { grants: 0, denies: 0 }; if (x.decision === 'GRANT') e.grants += x._count; else e.denies += x._count; m.set(k, e); }
      return m;
    };
    const svc = tally(byService, (x) => services.get(x.serviceId)?.code ?? null);
    const rdr = tally(readers, (x) => readerRows.get(x.readerId) ?? null);
    const sortDesc = <T extends { grants: number; denies: number }>(a: T, b: T) => b.grants + b.denies - (a.grants + a.denies);

    const all = [...days.values()];
    const grants = all.reduce((n, d) => n + d.grants, 0);
    return {
      from: r.from, to: r.to, generatedAt: new Date().toISOString(),
      totals: { decisions: total, grants, denies: total - grants },
      byDay: all,
      byService: [...svc].map(([code, v]) => ({ code, name: [...services.values()].find((s) => s.code === code)?.name ?? code, ...v })).sort(sortDesc),
      byReader: [...rdr].map(([name, v]) => ({ name, ...v })).sort(sortDesc).slice(0, 10),
      topDenialReasons: byReason.map((x) => ({ reason: x.reasonCode, count: x._count })),
      byMethod: byMethod.map((x) => ({ method: x.authMethod, count: x._count })),
    };
  }

  /**
   * CSV export of individual decisions. Contains student registration numbers, so it needs the log permission as well
   * as `reports.export`; every export is itself audited. Capped, and says so when it truncates.
   */
  @RequirePermissions('reports.export', 'access.logs.view')
  @Get('access/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async exportAccess(@Query() q: RangeQuery, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const r = resolveRange(q);
    const rows = await this.prisma.accessLog.findMany({
      where: { occurredAt: { gte: r.start, lt: r.end } }, orderBy: { occurredAt: 'asc' }, take: EXPORT_MAX_ROWS + 1,
      select: {
        occurredAt: true, decision: true, reasonCode: true, authMethod: true, direction: true, offline: true,
        service: { select: { code: true } }, reader: { select: { name: true } }, venue: { select: { name: true } },
        student: { select: { regNo: true } },
      },
    });
    const truncated = rows.length > EXPORT_MAX_ROWS;
    const body = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;
    await this.audit.record({
      actorId: u.id, action: 'reports.access_exported', entityType: 'AccessLog', after: { from: r.from, to: r.to, rows: body.length, truncated }, requestMeta: meta,
    });
    const head = 'occurred_at,decision,reason_code,service,reader,venue,reg_no,auth_method,direction,offline';
    const lines = body.map((x) => [x.occurredAt, x.decision, x.reasonCode, x.service?.code, x.reader?.name, x.venue?.name, x.student?.regNo, x.authMethod, x.direction, x.offline].map(csvCell).join(','));
    if (truncated) lines.push(csvCell(`# truncated at ${EXPORT_MAX_ROWS} rows: narrow the date range`));
    return new StreamableFile(Buffer.from('﻿' + [head, ...lines].join('\r\n') + '\r\n', 'utf8'), {
      disposition: `attachment; filename="access-${r.from}_${r.to}.csv"`,
    });
  }
}
