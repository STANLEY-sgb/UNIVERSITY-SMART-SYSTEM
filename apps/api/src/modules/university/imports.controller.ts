import { createHash } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { Authenticated, AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseBool, parseCsv } from './csv';

const KINDS = { FINANCE: 'FINANCE', REGISTRY: 'REGISTRY', LIBRARY: 'LIBRARY' } as const;
type Kind = keyof typeof KINDS;
/** The permission that already protects the same change made one student at a time. */
const NEEDS: Record<Kind, string> = { FINANCE: 'finance.update', REGISTRY: 'registry.manage', LIBRARY: 'library.manage' };
const COLUMNS: Record<Kind, { required: string[]; optional: string[] }> = {
  FINANCE: { required: ['reg_no'], optional: ['fees_paid_percent', 'exam_cleared'] },
  REGISTRY: { required: ['reg_no', 'semester_registered'], optional: [] },
  LIBRARY: { required: ['reg_no', 'fine_ugx'], optional: [] },
};
const MAX_ROWS = 1000;
const MAX_BYTES = 200 * 1024; // below the 256 KB JSON body limit, with room for escaping

class PreviewDto {
  @ApiProperty({ enum: Object.values(KINDS) }) @IsEnum(KINDS) kind!: Kind;
  @ApiProperty({ description: 'CSV text with a header row. Max 1000 rows / 200 KB.' }) @IsString() @MinLength(3) @MaxLength(MAX_BYTES) csv!: string;
}
class CommitDto extends PreviewDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string;
  @ApiProperty({ description: 'sha256 returned by the preview; the commit refuses a different file.' }) @IsString() @MaxLength(64) expectedSha256!: string;
}
class JobsQuery extends PageQuery {}

interface RowResult { line: number; regNo: string; status: 'OK' | 'UNCHANGED' | 'ERROR'; errors: string[]; before?: Record<string, unknown>; after?: Record<string, unknown> }
interface Plan { rows: RowResult[]; updates: { studentId: string; statusId: string; data: Prisma.StudentStatusUpdateInput; before: Record<string, unknown>; after: Record<string, unknown>; clearanceChanged?: boolean }[] }

@ApiTags('imports')
@ApiBearerAuth() @ApiCookieAuth()
@Controller('imports')
export class ImportsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private need(u: AuthUser, kind: Kind) {
    if (!u.permissions.includes(NEEDS[kind])) throw new ForbiddenException({ code: 'FORBIDDEN', message: `Importing ${kind.toLowerCase()} data needs the ${NEEDS[kind]} permission` });
  }

  /** Parses and validates the whole file against the database without changing anything. */
  private async plan(kind: Kind, csv: string): Promise<Plan> {
    if (Buffer.byteLength(csv) > MAX_BYTES) throw new BadRequestException({ code: 'FILE_TOO_LARGE', message: 'File is larger than 200 KB' });
    let table: string[][];
    try { table = parseCsv(csv); } catch (e) { throw new BadRequestException({ code: 'CSV_INVALID', message: (e as Error).message }); }
    if (table.length < 2) throw new BadRequestException({ code: 'CSV_EMPTY', message: 'The file needs a header row and at least one data row' });
    if (table.length - 1 > MAX_ROWS) throw new BadRequestException({ code: 'TOO_MANY_ROWS', message: `At most ${MAX_ROWS} data rows per import` });

    const header = table[0]!.map((h) => h.trim().toLowerCase());
    const spec = COLUMNS[kind];
    const missing = spec.required.filter((c) => !header.includes(c));
    if (missing.length) throw new BadRequestException({ code: 'MISSING_COLUMNS', message: `Missing column(s): ${missing.join(', ')}` });
    const unknown = header.filter((c) => !spec.required.includes(c) && !spec.optional.includes(c));
    if (unknown.length) throw new BadRequestException({ code: 'UNKNOWN_COLUMNS', message: `Unknown column(s): ${unknown.join(', ')}. Expected: ${[...spec.required, ...spec.optional].join(', ')}` });
    if (spec.optional.length && !spec.optional.some((c) => header.includes(c))) throw new BadRequestException({ code: 'NOTHING_TO_IMPORT', message: `Include at least one of: ${spec.optional.join(', ')}` });
    const col = (r: string[], name: string) => { const i = header.indexOf(name); return i < 0 ? undefined : (r[i] ?? '').trim(); };

    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    if (!semester) throw new ConflictException({ code: 'NO_CURRENT_SEMESTER', message: 'No current semester is configured' });

    const regNos = [...new Set(table.slice(1).map((r) => (col(r, 'reg_no') ?? '').toUpperCase()).filter(Boolean))];
    const students = await this.prisma.student.findMany({ where: { regNo: { in: regNos }, deletedAt: null }, select: { id: true, regNo: true } });
    const byReg = new Map(students.map((s) => [s.regNo, s.id]));
    const statuses = await this.prisma.studentStatus.findMany({ where: { semesterId: semester.id, studentId: { in: students.map((s) => s.id) } } });
    const statusOf = new Map(statuses.map((s) => [s.studentId, s]));

    const seen = new Set<string>();
    const out: Plan = { rows: [], updates: [] };
    table.slice(1).forEach((r, idx) => {
      const line = idx + 2;
      const regNo = (col(r, 'reg_no') ?? '').toUpperCase();
      const errors: string[] = [];
      const data: Prisma.StudentStatusUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const studentId = byReg.get(regNo);
      const st = studentId ? statusOf.get(studentId) : undefined;
      if (!regNo) errors.push('reg_no is empty');
      else if (seen.has(regNo)) errors.push('duplicate reg_no in this file');
      else if (!studentId) errors.push('unknown student');
      else if (!st) errors.push('student has no status record for the current semester');
      seen.add(regNo);

      const set = (key: string, field: 'feesPaidPercent' | 'examCleared' | 'semesterRegistered' | 'libraryFinesUgx', value: unknown, current: unknown) => {
        if (value === undefined) return;
        before[key] = current; after[key] = value;
        (data as Record<string, unknown>)[field] = value;
      };
      if (kind === 'FINANCE') {
        const f = col(r, 'fees_paid_percent');
        if (f !== undefined && f !== '') {
          const n = Number(f);
          if (!Number.isFinite(n) || n < 0 || n > 100) errors.push('fees_paid_percent must be a number from 0 to 100');
          else set('fees_paid_percent', 'feesPaidPercent', Math.round(n * 100) / 100, st ? Number(st.feesPaidPercent) : null);
        }
        const c = col(r, 'exam_cleared');
        if (c !== undefined && c !== '') {
          const b = parseBool(c);
          if (b === undefined) errors.push('exam_cleared must be true/false, yes/no or 1/0');
          else set('exam_cleared', 'examCleared', b, st?.examCleared ?? null);
        }
        if (!errors.length && !Object.keys(after).length) errors.push('row has no values to apply');
      } else if (kind === 'REGISTRY') {
        const b = parseBool(col(r, 'semester_registered') ?? '');
        if (b === undefined) errors.push('semester_registered must be true/false, yes/no or 1/0');
        else set('semester_registered', 'semesterRegistered', b, st?.semesterRegistered ?? null);
      } else {
        const raw = col(r, 'fine_ugx') ?? '';
        const n = Number(raw);
        if (raw === '' || !Number.isInteger(n) || n < 0 || n > 100_000_000) errors.push('fine_ugx must be a whole number from 0 to 100000000');
        else set('fine_ugx', 'libraryFinesUgx', n, st?.libraryFinesUgx ?? null);
      }

      if (errors.length || !studentId || !st) { out.rows.push({ line, regNo, status: 'ERROR', errors }); return; }
      const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      if (!changed.length) { out.rows.push({ line, regNo, status: 'UNCHANGED', errors: [], before, after }); return; }
      out.rows.push({ line, regNo, status: 'OK', errors: [], before, after });
      out.updates.push({ studentId, statusId: st.id, data, before, after, clearanceChanged: 'exam_cleared' in after && before.exam_cleared !== after.exam_cleared });
    });
    return out;
  }

  private summary(p: Plan) {
    return { total: p.rows.length, ok: p.rows.filter((r) => r.status === 'OK').length, unchanged: p.rows.filter((r) => r.status === 'UNCHANGED').length, errors: p.rows.filter((r) => r.status === 'ERROR').length };
  }

  @Authenticated()
  @Post('preview')
  @HttpCode(200)
  async preview(@Body() dto: PreviewDto, @CurrentUser() u: AuthUser) {
    this.need(u, dto.kind);
    const p = await this.plan(dto.kind, dto.csv);
    const sha = createHash('sha256').update(dto.csv).digest('hex');
    const dup = await this.prisma.syncJob.findFirst({ where: { kind: dto.kind, fileSha256: sha, status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } }, select: { id: true, finishedAt: true } });
    return { sha256: sha, summary: this.summary(p), alreadyImported: dup ? { jobId: dup.id, at: dup.finishedAt } : null, rows: p.rows.slice(0, 200), rowsShown: Math.min(200, p.rows.length) };
  }

  /** Re-validates the file itself (the preview is never trusted), applies the valid rows atomically and records one job. */
  @Authenticated()
  @Post('commit')
  @HttpCode(200)
  async commit(@Body() dto: CommitDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    this.need(u, dto.kind);
    const sha = createHash('sha256').update(dto.csv).digest('hex');
    if (sha !== dto.expectedSha256) throw new ConflictException({ code: 'FILE_CHANGED', message: 'The file differs from the one previewed. Preview it again.' });
    const dup = await this.prisma.syncJob.findFirst({ where: { kind: dto.kind, fileSha256: sha, status: { in: ['COMPLETED', 'COMPLETED_WITH_ERRORS'] } } });
    if (dup) throw new ConflictException({ code: 'DUPLICATE_IMPORT', message: 'This exact file was already imported.', jobId: dup.id });
    const p = await this.plan(dto.kind, dto.csv);
    const s = this.summary(p);
    if (s.ok === 0) throw new ConflictException({ code: 'NOTHING_TO_APPLY', message: 'No row would change anything', summary: s });

    return this.prisma.$transaction(async (tx) => {
      for (const up of p.updates) {
        await tx.studentStatus.update({ where: { id: up.statusId }, data: { ...up.data, factsVersion: { increment: 1 }, updatedBy: u.id } });
        await this.audit.record({ actorId: u.id, action: `import.${dto.kind.toLowerCase()}_row`, entityType: 'StudentStatus', entityId: up.statusId, before: up.before, after: up.after, reason: dto.reason, requestMeta: meta }, tx);
        if (up.clearanceChanged) {
          const cleared = up.after.exam_cleared === true;
          await tx.notification.create({ data: { studentId: up.studentId, kind: 'FINANCE_CLEARANCE', title: cleared ? 'Examination clearance granted' : 'Examination clearance withdrawn', body: cleared ? 'Finance has cleared you for examinations.' : 'Finance has withdrawn your examination clearance. Please visit the Finance office.' } });
        }
      }
      const failed = p.rows.filter((r) => r.status === 'ERROR');
      const job = await tx.syncJob.create({
        data: {
          kind: dto.kind, status: failed.length ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED', source: 'CSV_UPLOAD', fileSha256: sha,
          rowsTotal: s.total, rowsOk: s.ok + s.unchanged, rowsFailed: s.errors, errorReport: failed.length ? failed.slice(0, 200).map((f) => ({ line: f.line, regNo: f.regNo, errors: f.errors })) : Prisma.JsonNull,
          startedBy: u.id, finishedAt: new Date(),
        },
      });
      await this.audit.record({ actorId: u.id, action: 'import.committed', entityType: 'SyncJob', entityId: job.id, after: { kind: dto.kind, sha256: sha, ...s }, reason: dto.reason, requestMeta: meta }, tx);
      return { jobId: job.id, status: job.status, summary: s };
    });
  }

  @RequirePermissions('integrations.view')
  @Get('jobs')
  async jobs(@Query() q: JobsQuery) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.syncJob.findMany({ where: { source: 'CSV_UPLOAD' }, orderBy: { startedAt: 'desc' }, skip: q.skip, take: q.pageSize, select: { id: true, kind: true, status: true, rowsTotal: true, rowsOk: true, rowsFailed: true, errorReport: true, startedAt: true, finishedAt: true } }),
      this.prisma.syncJob.count({ where: { source: 'CSV_UPLOAD' } }),
    ]);
    return paged(rows, total, q);
  }
}
