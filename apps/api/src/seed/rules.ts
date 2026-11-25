import { Prisma, PrismaClient } from '@prisma/client';
import { validateRule } from '@kiu/rules-engine';

const L = (fact: string, op: string, value: unknown, reason: string, message: string, extra: object = {}) => ({ fact, op, value, reason, message, ...extra });
const active = L('account_active', 'eq', true, 'STUDENT_SUSPENDED', 'Student account is not active.');
const registered = L('semester_registered', 'eq', true, 'NOT_REGISTERED', 'Not registered for this semester. Visit the Registry.');

/**
 * Default rules. Thresholds referencing ctx.policy.* are PLACEHOLDERS awaiting KIU confirmation; the PDF's
 * 100 % exam-fee example is deliberately NOT encoded: exam entry depends on Finance's `exam_cleared` fact.
 */
export const DEFAULT_RULES: Record<string, unknown> = {
  GATE: { all: [active] }, // semester-registration at the gate is a configurable KIU policy; not enforced by default
  LIBRARY_ENTRY: { all: [active] },
  LIBRARY_BORROW: { all: [
    active,
    L('library_overdue_items', 'eq', 0, 'LIBRARY_OVERDUE', 'Return overdue library items before borrowing.'),
    L('library_fines_ugx', 'lte', { ctx: 'policy.fine_limit_ugx' }, 'LIBRARY_FINES', 'Outstanding library fines exceed the borrowing limit.'),
  ] },
  EXAM: { all: [
    active, registered,
    L('exam_cleared', 'eq', true, 'FINANCE_NOT_CLEARED', 'Examination clearance has not been granted by Finance.'),
    L('enrolled_course_units', 'contains', { ctx: 'course_unit' }, 'NOT_ENROLLED', 'Not enrolled in this course unit.'),
    L('ctx.venue_code', 'eq', { ctx: 'exam_venue_code' }, 'WRONG_VENUE', 'Wrong examination room for this paper.'),
    L('ctx.now', 'gte', { ctx: 'window_start' }, 'OUTSIDE_TIME_WINDOW', 'Examination entry has not opened yet.', { type: 'datetime' }),
    L('ctx.now', 'lte', { ctx: 'window_end' }, 'OUTSIDE_TIME_WINDOW', 'Examination entry has closed.', { type: 'datetime' }),
  ] },
  LECTURE: { all: [active, registered, L('enrolled_course_units', 'contains', { ctx: 'course_unit' }, 'NOT_ENROLLED', 'Not enrolled in this course unit.')] },
  HOSTEL: { all: [
    active,
    L('hostel_id', 'eq', { ctx: 'hostel_code' }, 'HOSTEL_NOT_ASSIGNED', 'Not allocated to this hostel.'),
    L('hostel_fees_paid', 'eq', true, 'HOSTEL_FEES_UNPAID', 'Hostel fees are outstanding.'),
  ] },
  CAFETERIA: { all: [active, L('meal_plan_active', 'eq', true, 'NO_MEAL_PLAN', 'No active meal plan.')] },
  LAB: { all: [active, registered] },
  HEALTH: { all: [active] },
  SPORTS: { all: [active] },
  TRANSPORT: { all: [active] },
  GRADUATION: { all: [active, L('exam_cleared', 'eq', true, 'FINANCE_NOT_CLEARED', 'Finance clearance is pending.')] },
};

export async function seedRules(prisma: PrismaClient): Promise<number> {
  await prisma.systemSetting.upsert({
    where: { key: 'policy' }, update: {},
    create: { key: 'policy', value: { fine_limit_ugx: 50_000 }, note: 'PLACEHOLDER policy values awaiting KIU confirmation' },
  });
  let created = 0;
  for (const [code, requirements] of Object.entries(DEFAULT_RULES)) {
    const service = await prisma.service.findUnique({ where: { code } });
    if (!service) continue;
    const rule = await prisma.accessRule.upsert({ where: { serviceId: service.id }, update: {}, create: { serviceId: service.id } });
    if (rule.publishedVersionId) continue; // never overwrite an administrator's published rule
    const def = { schemaVersion: 1, description: `Default ${code} rule (demo)`, requirements };
    const v = validateRule(def);
    if (!v.ok) throw new Error(`Seed rule ${code} invalid: ${v.errors.join('; ')}`);
    const version = await prisma.accessRuleVersion.create({
      data: { ruleId: rule.id, version: 1, status: 'PUBLISHED', definition: def as unknown as Prisma.InputJsonValue, changeNote: 'Seeded default', publishedAt: new Date(), effectiveFrom: new Date() },
    });
    await prisma.accessRule.update({ where: { id: rule.id }, data: { publishedVersionId: version.id } });
    created++;
  }
  return created;
}
