import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuthUser, CurrentUser, ReqMeta, RequestMeta, RequirePermissions } from '../../common/decorators';
import { PageQuery, paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EligibilityService } from '../access/eligibility.service';

class Reason { @ApiProperty() @IsString() @MinLength(5) @MaxLength(300) reason!: string }

class FinanceUpdateDto extends Reason {
  @ApiPropertyOptional({ minimum: 0, maximum: 100 }) @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) feesPaidPercent?: number;
  @ApiPropertyOptional({ description: 'Examination clearance granted by Finance.' }) @IsOptional() @IsBoolean() examCleared?: boolean;
}
class RegistrationDto extends Reason { @ApiProperty() @IsBoolean() semesterRegistered!: boolean }
class FinesDto extends Reason { @ApiProperty({ minimum: 0 }) @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) fineUgx!: number }
class LoanDto {
  @ApiProperty() @IsString() @MaxLength(32) regNo!: string;
  @ApiProperty({ example: 'BK-000123' }) @IsString() @Matches(/^[A-Za-z0-9._/-]{3,40}$/) itemRef!: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(160) title!: string;
  @ApiPropertyOptional({ default: 14, minimum: 1, maximum: 60 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) days?: number;
}
class StudentsQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum({ cleared: 'cleared', pending: 'pending' }) clearance?: 'cleared' | 'pending';
}
class LoansQuery extends PageQuery {
  @IsOptional() @IsString() @MaxLength(32) regNo?: string;
  @IsOptional() @IsEnum({ ACTIVE: 'ACTIVE', OVERDUE: 'OVERDUE', RETURNED: 'RETURNED' }) status?: 'ACTIVE' | 'OVERDUE' | 'RETURNED';
}

const DAY = 86_400_000;

@ApiTags('university')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class UniversityController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly eligibility: EligibilityService) {}

  private async currentFacts(regNo: string, create = false) {
    const student = await this.prisma.student.findFirst({ where: { regNo: regNo.toUpperCase(), deletedAt: null } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    if (!semester) throw new ConflictException({ code: 'NO_CURRENT_SEMESTER', message: 'No current semester is configured' });
    let status = await this.prisma.studentStatus.findUnique({ where: { studentId_semesterId: { studentId: student.id, semesterId: semester.id } } });
    if (!status && create) status = await this.prisma.studentStatus.create({ data: { studentId: student.id, semesterId: semester.id } });
    if (!status) throw new NotFoundException({ code: 'NO_STATUS_RECORD', message: 'No status record for the current semester' });
    return { student, semester, status };
  }

  private snapshot(s: { feesPaidPercent: Prisma.Decimal; examCleared: boolean; semesterRegistered: boolean; libraryOverdueItems: number; libraryFinesUgx: number }) {
    return { feesPaidPercent: Number(s.feesPaidPercent), examCleared: s.examCleared, semesterRegistered: s.semesterRegistered, libraryOverdueItems: s.libraryOverdueItems, libraryFinesUgx: s.libraryFinesUgx };
  }

  /** Student-facing notice. Facts are read live by every decision, so there is no cache to invalidate. */
  private notify(tx: Prisma.TransactionClient, studentId: string, kind: string, title: string, body: string) {
    return tx.notification.create({ data: { studentId, kind, title, body } });
  }

  // ───────────────────────── Finance ─────────────────────────

  @RequirePermissions('finance.view')
  @Get('finance/students')
  async financeList(@Query() q: StudentsQuery) {
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    const where: Prisma.StudentStatusWhereInput = {
      semesterId: semester?.id ?? '00000000-0000-0000-0000-000000000000',
      ...(q.clearance ? { examCleared: q.clearance === 'cleared' } : {}),
      student: { deletedAt: null, ...(q.q ? { OR: [{ regNo: { contains: q.q, mode: 'insensitive' } }, { fullName: { contains: q.q, mode: 'insensitive' } }] } : {}) },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.studentStatus.findMany({ where, orderBy: { student: { regNo: 'asc' } }, skip: q.skip, take: q.pageSize, select: { feesPaidPercent: true, examCleared: true, updatedAt: true, student: { select: { id: true, regNo: true, fullName: true, programme: { select: { code: true } } } } } }),
      this.prisma.studentStatus.count({ where }),
    ]);
    return paged(rows.map((r) => ({ id: r.student.id, regNo: r.student.regNo, fullName: r.student.fullName, programme: r.student.programme.code, feesPaidPercent: Number(r.feesPaidPercent), examCleared: r.examCleared, updatedAt: r.updatedAt })), total, q);
  }

  /** Finance records a payment-status change. The very next access decision uses it. */
  @RequirePermissions('finance.update')
  @Patch('finance/students/:regNo')
  async financeUpdate(@Param('regNo') regNo: string, @Body() dto: FinanceUpdateDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    if (dto.feesPaidPercent === undefined && dto.examCleared === undefined) throw new ConflictException({ code: 'NOTHING_TO_UPDATE', message: 'Provide feesPaidPercent and/or examCleared' });
    const { student, status } = await this.currentFacts(regNo, true);
    const before = this.snapshot(status);
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.studentStatus.update({
        where: { id: status.id },
        data: { ...(dto.feesPaidPercent !== undefined ? { feesPaidPercent: dto.feesPaidPercent } : {}), ...(dto.examCleared !== undefined ? { examCleared: dto.examCleared } : {}), factsVersion: { increment: 1 }, updatedBy: u.id },
      });
      const after = this.snapshot(next);
      await this.audit.record({ actorId: u.id, action: 'finance.status_update', entityType: 'StudentStatus', entityId: status.id, before, after, reason: dto.reason, requestMeta: meta }, tx);
      if (before.examCleared !== after.examCleared) {
        await this.notify(tx, student.id, 'FINANCE_CLEARANCE', after.examCleared ? 'Examination clearance granted' : 'Examination clearance withdrawn', after.examCleared ? 'Finance has cleared you for examinations.' : 'Finance has withdrawn your examination clearance. Please visit the Finance office.');
      }
      return { regNo: student.regNo, ...after, factsVersion: next.factsVersion };
    });
  }

  // ───────────────────────── Registry ─────────────────────────

  @RequirePermissions('registry.manage')
  @Patch('registry/students/:regNo/registration')
  async registration(@Param('regNo') regNo: string, @Body() dto: RegistrationDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const { student, status } = await this.currentFacts(regNo, true);
    const before = this.snapshot(status);
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.studentStatus.update({ where: { id: status.id }, data: { semesterRegistered: dto.semesterRegistered, factsVersion: { increment: 1 }, updatedBy: u.id } });
      await this.audit.record({ actorId: u.id, action: 'registry.registration_update', entityType: 'StudentStatus', entityId: status.id, before, after: this.snapshot(next), reason: dto.reason, requestMeta: meta }, tx);
      await this.notify(tx, student.id, 'REGISTRATION', dto.semesterRegistered ? 'Semester registration confirmed' : 'Semester registration removed', dto.semesterRegistered ? 'The Registry has confirmed your registration.' : 'Your semester registration was removed. Contact the Registry.');
      return { regNo: student.regNo, semesterRegistered: next.semesterRegistered };
    });
  }

  // ───────────────────────── Library ─────────────────────────

  /** Recomputes the library facts from the loans themselves: late items flip to OVERDUE, the count feeds the rules. */
  private async syncLibrary(tx: Prisma.TransactionClient, studentId: string) {
    await tx.libraryLoan.updateMany({ where: { studentId, status: 'ACTIVE', dueAt: { lt: new Date() } }, data: { status: 'OVERDUE' } });
    const overdue = await tx.libraryLoan.count({ where: { studentId, status: 'OVERDUE' } });
    const semester = await tx.semester.findFirst({ where: { isCurrent: true } });
    if (semester) await tx.studentStatus.updateMany({ where: { studentId, semesterId: semester.id }, data: { libraryOverdueItems: overdue, factsVersion: { increment: 1 } } });
    return overdue;
  }

  @RequirePermissions('library.view')
  @Get('library/loans')
  async loans(@Query() q: LoansQuery) {
    const where: Prisma.LibraryLoanWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.regNo ? { student: { regNo: q.regNo.toUpperCase() } } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryLoan.findMany({ where, orderBy: { borrowedAt: 'desc' }, skip: q.skip, take: q.pageSize, select: { id: true, itemRef: true, title: true, borrowedAt: true, dueAt: true, returnedAt: true, status: true, fineUgx: true, student: { select: { regNo: true, fullName: true } } } }),
      this.prisma.libraryLoan.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  /** Recording a loan re-checks borrowing eligibility with the same published rule readers use. */
  @RequirePermissions('library.manage')
  @Post('library/loans')
  async lend(@Body() dto: LoanDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const student = await this.prisma.student.findFirst({ where: { regNo: dto.regNo.toUpperCase(), deletedAt: null } });
    if (!student) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    await this.prisma.$transaction((tx) => this.syncLibrary(tx, student.id));
    const el = (await this.eligibility.forStudent(student.id)).services.find((s) => s.service === 'LIBRARY_BORROW');
    if (!el || el.status !== 'ELIGIBLE') {
      throw new ConflictException({ code: el?.reason_code ?? 'NOT_ELIGIBLE', message: el?.message ?? 'Borrowing is not available for this student.' });
    }
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.libraryLoan.create({ data: { studentId: student.id, itemRef: dto.itemRef, title: dto.title, dueAt: new Date(Date.now() + (dto.days ?? 14) * DAY) }, select: { id: true, itemRef: true, title: true, dueAt: true, status: true } });
      await this.audit.record({ actorId: u.id, action: 'library.loan_created', entityType: 'LibraryLoan', entityId: loan.id, after: { regNo: student.regNo, ...loan }, requestMeta: meta }, tx);
      return loan;
    });
  }

  /** Returning an item recomputes the facts, so an overdue block lifts on the very next scan. */
  @RequirePermissions('library.manage')
  @Post('library/loans/:id/return')
  @HttpCode(200)
  async giveBack(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const loan = await this.prisma.libraryLoan.findUnique({ where: { id }, include: { student: true } });
    if (!loan) throw new NotFoundException({ code: 'LOAN_NOT_FOUND', message: 'Loan not found' });
    if (loan.status === 'RETURNED') throw new ConflictException({ code: 'ALREADY_RETURNED', message: 'This item was already returned' });
    return this.prisma.$transaction(async (tx) => {
      await tx.libraryLoan.update({ where: { id }, data: { status: 'RETURNED', returnedAt: new Date() } });
      const overdue = await this.syncLibrary(tx, loan.studentId);
      await this.audit.record({ actorId: u.id, action: 'library.loan_returned', entityType: 'LibraryLoan', entityId: id, before: { status: loan.status }, after: { status: 'RETURNED', overdueItemsNow: overdue }, requestMeta: meta }, tx);
      if (loan.status === 'OVERDUE') await this.notify(tx, loan.studentId, 'LIBRARY_RETURN', 'Library item returned', overdue === 0 ? 'Your overdue items are cleared.' : `${overdue} overdue item(s) remain.`);
      return { id, status: 'RETURNED', overdueItemsNow: overdue };
    });
  }

  @RequirePermissions('library.manage')
  @Patch('library/students/:regNo/fines')
  async setFines(@Param('regNo') regNo: string, @Body() dto: FinesDto, @CurrentUser() u: AuthUser, @ReqMeta() meta: RequestMeta) {
    const { student, status } = await this.currentFacts(regNo, true);
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.studentStatus.update({ where: { id: status.id }, data: { libraryFinesUgx: dto.fineUgx, factsVersion: { increment: 1 }, updatedBy: u.id } });
      await this.audit.record({ actorId: u.id, action: 'library.fines_update', entityType: 'StudentStatus', entityId: status.id, before: { libraryFinesUgx: status.libraryFinesUgx }, after: { libraryFinesUgx: next.libraryFinesUgx }, reason: dto.reason, requestMeta: meta }, tx);
      return { regNo: student.regNo, libraryFinesUgx: next.libraryFinesUgx };
    });
  }
}
