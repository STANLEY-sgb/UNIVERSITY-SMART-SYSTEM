import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { Response } from 'express';
import { AuthUser, Authenticated, CurrentUser, ReqMeta, RequestMeta } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { csvCell, resolveRange } from './reports.controller';

const MAX_ROWS = 5000;
type Cell = string | number | null;
interface Report { title: string; columns: { key: string; label: string }[]; rows: Record<string, Cell>[]; summary: Record<string, Cell>; truncated: boolean }
interface Range { start: Date; end: Date; from: string; to: string }
interface Kind { perm: string; label: string; ranged: boolean; run: (p: PrismaService, r: Range) => Promise<Report> }

class DomainQuery {
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @ApiPropertyOptional({ enum: ['json', 'csv'] }) @IsOptional() @IsIn(['json', 'csv']) format?: 'json' | 'csv';
}

const cap = <T>(rows: T[]) => ({ rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS });
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Each report is a plain read; the permission that guards the underlying data also guards its report. */
const KINDS: Record<string, Kind> = {
  'exam-attendance': {
    perm: 'exams.attendance.view', label: 'Examination attendance', ranged: true,
    async run(p, r) {
      const exams = await p.examSession.findMany({
        where: { startsAt: { gte: r.start, lt: r.end } }, orderBy: { startsAt: 'asc' },
        select: { id: true, startsAt: true, courseUnitId: true, semesterId: true, courseUnit: { select: { code: true, title: true } }, venue: { select: { name: true } }, attendance: { select: { status: true } } },
      });
      const rows = await Promise.all(exams.map(async (e) => {
        const enrolled = await p.enrolment.count({ where: { courseUnitId: e.courseUnitId, semesterId: e.semesterId } });
        const present = e.attendance.filter((a) => a.status === 'PRESENT').length, overridden = e.attendance.filter((a) => a.status === 'OVERRIDDEN').length;
        return { course: `${e.courseUnit.code} ${e.courseUnit.title}`, hall: e.venue.name, starts: e.startsAt.toISOString(), enrolled, present, overridden, attendedPct: enrolled ? Math.round(((present + overridden) / enrolled) * 100) : null };
      }));
      const sum = (k: 'enrolled' | 'present' | 'overridden') => rows.reduce((n, x) => n + x[k], 0);
      return {
        title: 'Examination attendance', truncated: false, rows,
        columns: [['course', 'Course'], ['hall', 'Hall'], ['starts', 'Starts'], ['enrolled', 'Enrolled'], ['present', 'Present'], ['overridden', 'Admitted by override'], ['attendedPct', 'Attended %']].map(([key, label]) => ({ key: key!, label: label! })),
        summary: { examinations: rows.length, enrolledSeats: sum('enrolled'), present: sum('present'), overridden: sum('overridden') },
      };
    },
  },
  'finance-clearance': {
    perm: 'finance.view', label: 'Students not cleared for examinations', ranged: false,
    async run(p) {
      const sem = await p.semester.findFirst({ where: { isCurrent: true } });
      if (!sem) throw new BadRequestException({ code: 'NO_CURRENT_SEMESTER', message: 'There is no current semester' });
      const [total, cleared] = await Promise.all([p.studentStatus.count({ where: { semesterId: sem.id } }), p.studentStatus.count({ where: { semesterId: sem.id, examCleared: true } })]);
      const rows = await p.studentStatus.findMany({
        where: { semesterId: sem.id, examCleared: false, student: { accountStatus: 'ACTIVE', deletedAt: null } }, orderBy: { student: { regNo: 'asc' } }, take: MAX_ROWS + 1,
        select: { feesPaidPercent: true, semesterRegistered: true, libraryFinesUgx: true, student: { select: { regNo: true, fullName: true } } },
      });
      const c = cap(rows.map((x) => ({ regNo: x.student.regNo, name: x.student.fullName, feesPaidPercent: Number(x.feesPaidPercent), registered: x.semesterRegistered ? 'yes' : 'no', fines: x.libraryFinesUgx })));
      return {
        title: 'Students not cleared for examinations', ...c,
        columns: [['regNo', 'Reg. no.'], ['name', 'Name'], ['feesPaidPercent', 'Fees paid %'], ['registered', 'Registered'], ['fines', 'Library fines (UGX)']].map(([key, label]) => ({ key: key!, label: label! })),
        summary: { students: total, cleared, notCleared: total - cleared },
      };
    },
  },
  'library-overdue': {
    perm: 'library.view', label: 'Overdue library loans', ranged: false,
    async run(p) {
      const now = new Date();
      const loans = await p.libraryLoan.findMany({ where: { returnedAt: null, dueAt: { lt: now } }, orderBy: { dueAt: 'asc' }, take: MAX_ROWS + 1, select: { title: true, itemRef: true, dueAt: true, fineUgx: true, student: { select: { regNo: true, fullName: true } } } });
      const c = cap(loans.map((l) => ({ regNo: l.student.regNo, name: l.student.fullName, title: l.title, item: l.itemRef, due: l.dueAt.toISOString(), daysOverdue: Math.floor((now.getTime() - l.dueAt.getTime()) / 86_400_000), fine: l.fineUgx })));
      return {
        title: 'Overdue library loans', ...c,
        columns: [['regNo', 'Reg. no.'], ['name', 'Name'], ['title', 'Title'], ['item', 'Item'], ['due', 'Due'], ['daysOverdue', 'Days overdue'], ['fine', 'Fine (UGX)']].map(([key, label]) => ({ key: key!, label: label! })),
        summary: { overdueLoans: loans.length, students: new Set(loans.map((l) => l.student.regNo)).size, fineUgx: loans.reduce((n, l) => n + l.fineUgx, 0) },
      };
    },
  },
  'meals-served': {
    perm: 'cafeteria.view', label: 'Meals served', ranged: true,
    async run(p, r) {
      const usage = await p.mealUsage.groupBy({ by: ['servedOn', 'sittingId'], where: { servedOn: { gte: r.start, lt: r.end } }, _count: true, orderBy: { servedOn: 'asc' } });
      const sittings = new Map((await p.mealSitting.findMany()).map((s) => [s.id, s.mealType as string]));
      const byDay = new Map<string, Record<string, number>>();
      for (const u of usage) { const d = u.servedOn.toISOString().slice(0, 10); const e = byDay.get(d) ?? {}; const t = sittings.get(u.sittingId) ?? '?'; e[t] = (e[t] ?? 0) + u._count; byDay.set(d, e); }
      const rows = [...byDay].map(([date, e]) => ({ date, breakfast: e.BREAKFAST ?? 0, lunch: e.LUNCH ?? 0, dinner: e.DINNER ?? 0, total: Object.values(e).reduce((n, v) => n + v, 0) }));
      return {
        title: 'Meals served', rows, truncated: false,
        columns: [['date', 'Date'], ['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['total', 'Total']].map(([key, label]) => ({ key: key!, label: label! })),
        summary: { days: rows.length, meals: rows.reduce((n, x) => n + x.total, 0) },
      };
    },
  },
  'hostel-occupancy': {
    perm: 'hostel.view', label: 'Hostel occupancy', ranged: false,
    async run(p) {
      const hostels = await p.hostel.findMany({ orderBy: { code: 'asc' }, select: { code: true, name: true, _count: { select: { allocations: { where: { active: true } } } } } });
      const rows = hostels.map((h) => ({ code: h.code, hostel: h.name, residents: h._count.allocations }));
      return {
        title: 'Hostel occupancy', rows, truncated: false,
        columns: [['code', 'Code'], ['hostel', 'Hostel'], ['residents', 'Residents']].map(([key, label]) => ({ key: key!, label: label! })),
        summary: { hostels: rows.length, residents: rows.reduce((n, x) => n + x.residents, 0) },
      };
    },
  },
};

@ApiTags('reports')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('reports')
export class DomainReportsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** The reports this caller may run (their data permission is the report permission). */
  @Authenticated()
  @Get('catalog')
  catalog(@CurrentUser() u: AuthUser) {
    return Object.entries(KINDS).filter(([, k]) => u.permissions.includes(k.perm)).map(([id, k]) => ({ id, label: k.label, ranged: k.ranged, canExport: u.permissions.includes('reports.export') }));
  }

  @Authenticated()
  @Get('domain/:kind')
  async run(@Param('kind') kind: string, @Query() q: DomainQuery, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const k = KINDS[kind];
    if (!k) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', message: 'Unknown report' });
    if (!u.permissions.includes(k.perm)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have access to this report' });
    const range = resolveRange(k.ranged ? q : {});
    const report = await k.run(this.prisma, range);
    if (q.format !== 'csv') return { id: kind, ...(k.ranged ? { from: range.from, to: range.to } : {}), generatedAt: new Date().toISOString(), ...report };

    if (!u.permissions.includes('reports.export')) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Exporting needs the reports.export permission' });
    await this.audit.record({ actorId: u.id, action: 'reports.exported', entityType: 'Report', entityId: kind, after: { rows: report.rows.length, truncated: report.truncated, ...(k.ranged ? { from: range.from, to: range.to } : {}) }, requestMeta: meta });
    const head = report.columns.map((c) => csvCell(c.label)).join(',');
    const lines = report.rows.map((r) => report.columns.map((c) => csvCell(r[c.key] ?? '')).join(','));
    if (report.truncated) lines.push(csvCell(`# truncated at ${MAX_ROWS} rows`));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    return new StreamableFile(Buffer.from('﻿' + [head, ...lines].join('\r\n') + '\r\n', 'utf8'), { disposition: `attachment; filename="${kind}-${day(new Date())}.csv"` });
  }
}
