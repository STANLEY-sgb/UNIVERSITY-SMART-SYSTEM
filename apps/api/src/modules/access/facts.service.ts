import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Policy values that KIU has not confirmed. Defaults are placeholders, editable in system_settings('policy'). */
export const DEFAULT_POLICY = {
  fine_limit_ugx: 50_000,       // awaiting KIU confirmation
  exam_min_fees_percent: 100,   // PDF example only, NOT official policy; exam rule uses Finance's exam_cleared fact
  gate_direction_required: false, // when true a gate scan without ENTRY/EXIT is refused; awaiting KIU confirmation
} as const;

export type Facts = Record<string, unknown>;

/** Builds the plain-value fact set the rules engine evaluates. Pure data: no behaviour leaks into rules. */
@Injectable()
export class FactsService {
  constructor(private readonly prisma: PrismaService) {}

  async policy(): Promise<Record<string, unknown>> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'policy' } });
    return { ...DEFAULT_POLICY, ...((row?.value as Record<string, unknown> | null) ?? {}) };
  }

  async baseContext(now = new Date()): Promise<Facts> {
    return { now: now.toISOString(), policy: await this.policy() };
  }

  /**
   * Loads current eligibility facts. Returns only what is known: a student with no status row for the
   * current semester has NO eligibility facts, so any rule needing them fails closed (FACT_UNKNOWN).
   */
  async loadFacts(studentId: string, cardStatus: string | null): Promise<Facts> {
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    const facts: Facts = { account_active: student.accountStatus === 'ACTIVE', account_status: student.accountStatus };
    if (cardStatus) facts.card_status = cardStatus;
    if (!semester) return facts;

    const [status, enrolments, hostel] = await Promise.all([
      this.prisma.studentStatus.findUnique({ where: { studentId_semesterId: { studentId, semesterId: semester.id } } }),
      this.prisma.enrolment.findMany({ where: { studentId, semesterId: semester.id }, include: { courseUnit: true } }),
      this.prisma.hostelAllocation.findFirst({ where: { studentId, active: true }, include: { hostel: true } }),
    ]);
    if (status) {
      Object.assign(facts, {
        semester_registered: status.semesterRegistered,
        fees_paid_percent: Number(status.feesPaidPercent),
        exam_cleared: status.examCleared,
        library_overdue_items: status.libraryOverdueItems,
        library_fines_ugx: status.libraryFinesUgx,
        hostel_fees_paid: status.hostelFeesPaid,
        meal_plan_active: status.mealPlanActive,
      });
    }
    facts.enrolled_course_units = enrolments.map((e) => e.courseUnit.code);
    facts.hostel_id = hostel ? hostel.hostel.code : ''; // no allocation is a known fact (not allocated), not a missing one
    return facts;
  }
}
