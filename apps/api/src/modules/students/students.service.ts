import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser, RequestMeta } from '../../common/decorators';
import { paged } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateStudentDto, ListStudentsQuery, UpdateStudentStatusDto } from './students.dto';

/** Safe projection: no photo hashes, no internal flags beyond what operators need. */
const studentSelect = {
  id: true, regNo: true, fullName: true, email: true, phone: true, yearOfStudy: true, accountStatus: true, createdAt: true,
  programme: { select: { id: true, code: true, name: true, department: { select: { name: true, faculty: true } } } },
  cards: { where: { status: 'ACTIVE' }, select: { id: true, cardNumber: true, status: true, expiresAt: true }, take: 1 },
} satisfies Prisma.StudentSelect;

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(q: ListStudentsQuery) {
    const where: Prisma.StudentWhereInput = {
      deletedAt: null,
      ...(q.programmeId ? { programmeId: q.programmeId } : {}),
      ...(q.yearOfStudy ? { yearOfStudy: q.yearOfStudy } : {}),
      ...(q.accountStatus ? { accountStatus: q.accountStatus } : {}),
      ...(q.q ? { OR: [{ regNo: { contains: q.q, mode: 'insensitive' } }, { fullName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.student.findMany({ where, select: studentSelect, orderBy: { regNo: 'asc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.student.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  async get(id: string) {
    const s = await this.prisma.student.findFirst({ where: { id, deletedAt: null }, select: studentSelect });
    if (!s) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    return s;
  }

  async create(dto: CreateStudentDto, actor: AuthUser, meta: RequestMeta) {
    const regNo = dto.regNo.trim().toUpperCase();
    if (await this.prisma.student.findUnique({ where: { regNo } })) {
      throw new ConflictException({ code: 'REG_NO_IN_USE', message: 'A student with this registration number already exists' });
    }
    if (!(await this.prisma.programme.findUnique({ where: { id: dto.programmeId } }))) {
      throw new NotFoundException({ code: 'PROGRAMME_NOT_FOUND', message: 'Programme not found' });
    }
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.student.create({
        data: { regNo, fullName: dto.fullName.trim(), programmeId: dto.programmeId, yearOfStudy: dto.yearOfStudy, email: dto.email ?? null, phone: dto.phone ?? null },
        select: studentSelect,
      });
      // Eligibility facts start closed (fail-closed): nothing is cleared until Finance/Registry say so.
      const semester = await tx.semester.findFirst({ where: { isCurrent: true } });
      if (semester) await tx.studentStatus.create({ data: { studentId: s.id, semesterId: semester.id, updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'students.create', entityType: 'Student', entityId: s.id, after: s, requestMeta: meta }, tx);
      return s;
    });
  }

  /** PATCH /students/:reg_no/status — suspends or restores the student account. */
  async updateStatus(regNo: string, dto: UpdateStudentStatusDto, actor: AuthUser, meta: RequestMeta) {
    const current = await this.prisma.student.findFirst({ where: { regNo: regNo.toUpperCase(), deletedAt: null }, select: studentSelect });
    if (!current) throw new NotFoundException({ code: 'STUDENT_NOT_FOUND', message: 'Student not found' });
    return this.prisma.$transaction(async (tx) => {
      const s = await tx.student.update({ where: { id: current.id }, data: { accountStatus: dto.accountStatus }, select: studentSelect });
      await this.audit.record({
        actorId: actor.id, action: 'students.status_change', entityType: 'Student', entityId: s.id,
        before: { accountStatus: current.accountStatus }, after: { accountStatus: s.accountStatus }, reason: dto.reason, requestMeta: meta,
      }, tx);
      return s;
    });
  }
}
