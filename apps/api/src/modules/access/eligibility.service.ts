import { Injectable } from '@nestjs/common';
import { evaluate, validateRule } from '@kiu/rules-engine';
import { PrismaService } from '../../prisma/prisma.service';
import { FactsService } from './facts.service';

/** Where a student should go when a condition is unmet (PDF: "explain the unmet condition and the appropriate office"). */
export const OFFICE_FOR_REASON: Record<string, string> = {
  FINANCE_NOT_CLEARED: 'Finance Office',
  NOT_REGISTERED: 'Academic Registry',
  NOT_ENROLLED: 'Academic Registry',
  STUDENT_SUSPENDED: 'Dean of Students / Registry',
  LIBRARY_OVERDUE: 'Library',
  LIBRARY_FINES: 'Library',
  HOSTEL_NOT_ASSIGNED: 'Hostel Warden',
  HOSTEL_FEES_UNPAID: 'Finance Office / Hostel Warden',
  NO_MEAL_PLAN: 'Finance Office / Cafeteria',
  WRONG_VENUE: 'Your examination timetable',
  OUTSIDE_TIME_WINDOW: 'Your timetable',
  FACT_UNKNOWN: 'Academic Registry or Finance Office',
};

export type EligibilityStatus = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'UNAVAILABLE';

export interface ServiceEligibility {
  service: string;
  name: string;
  status: EligibilityStatus;
  reason_code: string | null;
  message: string;
  office: string | null;
  detail?: Record<string, unknown>;
}

/**
 * "What can I use right now, and if not, why?" for ONE student. It runs the same published rules through the same
 * evaluator the readers use, so the portal can never disagree with a reader about eligibility.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService, private readonly facts: FactsService) {}

  async forStudent(studentId: string) {
    const student = await this.prisma.student.findUniqueOrThrow({ where: { id: studentId }, include: { programme: true } });
    const card = await this.prisma.card.findFirst({
      where: { studentId, status: { in: ['ACTIVE', 'BLOCKED', 'PENDING'] } }, orderBy: { createdAt: 'desc' },
      select: { cardNumber: true, status: true, expiresAt: true },
    });
    const facts = await this.facts.loadFacts(studentId, card?.status ?? null);
    const now = new Date();
    const base = await this.facts.baseContext(now);
    const semester = await this.prisma.semester.findFirst({ where: { isCurrent: true } });
    const enrolled = (facts.enrolled_course_units as string[] | undefined) ?? [];

    const services = await this.prisma.service.findMany({
      where: { active: true }, orderBy: { name: 'asc' },
      include: { rules: { include: { published: true } } },
    });

    const out: ServiceEligibility[] = [];
    for (const s of services) {
      const published = s.rules[0]?.published;
      const row = (status: EligibilityStatus, message: string, reason: string | null = null, detail?: Record<string, unknown>): ServiceEligibility => ({
        service: s.code, name: s.name, status, reason_code: reason, message,
        office: reason ? (OFFICE_FOR_REASON[reason] ?? null) : null, ...(detail ? { detail } : {}),
      });
      if (!published) { out.push(row('UNAVAILABLE', 'This service has no access rule configured yet.')); continue; }
      const parsed = validateRule(published.definition);
      if (!parsed.ok) { out.push(row('UNAVAILABLE', 'This service is temporarily unavailable.')); continue; }

      const ctx: Record<string, unknown> = { ...base, service: s.code };
      let detail: Record<string, unknown> | undefined;

      if (s.code === 'EXAM') {
        const exam = semester && enrolled.length
          ? await this.prisma.examSession.findFirst({
              where: { semesterId: semester.id, courseUnit: { code: { in: enrolled } }, endsAt: { gte: now } },
              orderBy: { startsAt: 'asc' }, include: { courseUnit: true, venue: true },
            })
          : null;
        if (!exam) { out.push(row('NOT_APPLICABLE', 'No upcoming examination found for your enrolled course units.')); continue; }
        Object.assign(ctx, {
          course_unit: exam.courseUnit.code, exam_venue_code: exam.venue.code, venue_code: exam.venue.code,
          window_start: exam.entryOpensAt.toISOString(), window_end: exam.entryClosesAt.toISOString(),
        });
        detail = { course_unit: exam.courseUnit.code, title: exam.courseUnit.title, venue: exam.venue.name, starts_at: exam.startsAt.toISOString(), entry_opens_at: exam.entryOpensAt.toISOString() };
      } else if (s.code === 'LECTURE') {
        if (!enrolled.length) { out.push(row('NOT_ELIGIBLE', 'You are not enrolled in any course unit this semester.', 'NOT_ENROLLED')); continue; }
        ctx.course_unit = enrolled[0];
      } else if (s.code === 'HOSTEL') {
        if (!facts.hostel_id) { out.push(row('NOT_ELIGIBLE', 'You are not allocated to a hostel.', 'HOSTEL_NOT_ASSIGNED')); continue; }
        ctx.hostel_code = facts.hostel_id;
      }

      const r = evaluate(parsed.definition!, facts, ctx);
      if (r.allowed) out.push(row('ELIGIBLE', 'You can use this service.', null, detail));
      else if (r.failure!.reason === 'FACT_UNKNOWN') out.push(row('UNKNOWN', 'We do not have the information needed to confirm this yet.', 'FACT_UNKNOWN', detail));
      else out.push(row('NOT_ELIGIBLE', r.failure!.message, r.failure!.reason, detail));
    }

    return {
      student: { reg_no: student.regNo, full_name: student.fullName, programme: student.programme.name, year_of_study: student.yearOfStudy, account_status: student.accountStatus },
      card: card ? { status: card.status, expires_at: card.expiresAt } : null,
      services: out,
      generated_at: now.toISOString(),
    };
  }
}
