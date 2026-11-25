import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { REASON_CODES } from '@kiu/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { FactsService } from './facts.service';
import type { ReaderContext } from '../readers/reader-auth.guard';

export interface Denial { reason: string; message: string }

/** Per-service data gathered BEFORE rule evaluation and the side effects applied only AFTER a rule grants. */
export interface Prep {
  context: Record<string, unknown>;
  denial?: Denial;
  scheduleId?: string;
  heldOn?: Date;
  mealUsageId?: string;
}

const LECTURE_EARLY_MINUTES = 15;
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const nowMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();
/** Calendar day (server-local) as a UTC-midnight date, matching how @db.Date values are stored. */
const dayOf = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

/**
 * Service workflows layered on the shared pipeline: lecture timetable, hostel context, meal sittings (one meal per
 * sitting) and gate anti-passback. The credential type is irrelevant here: all of it runs after identity is resolved.
 * Times use the server's local clock (a placeholder policy until KIU confirms a campus timezone setting).
 */
@Injectable()
export class WorkflowsService {
  constructor(private readonly prisma: PrismaService, private readonly facts: FactsService) {}

  /** Context needed to evaluate the rule, or a precise denial when the situation itself is invalid (no class/meal now). */
  async prepare(reader: ReaderContext, hint: { courseUnitCode?: string | undefined } | undefined, now: Date): Promise<Prep> {
    const context: Record<string, unknown> = {};
    switch (reader.serviceCode) {
      case 'LECTURE': {
        const schedules = await this.prisma.lectureSchedule.findMany({
          where: { venueId: reader.venueId, dayOfWeek: now.getDay(), ...(hint?.courseUnitCode ? { courseUnit: { code: hint.courseUnitCode } } : {}) },
          include: { courseUnit: true },
        });
        const at = nowMinutes(now);
        const live = schedules.find((s) => at >= minutes(s.startsAt) - LECTURE_EARLY_MINUTES && at <= minutes(s.endsAt));
        if (!live) return { context, denial: { reason: REASON_CODES.OUTSIDE_TIME_WINDOW, message: 'No lecture is scheduled in this room right now.' } };
        context.course_unit = live.courseUnit.code;
        return { context, scheduleId: live.id, heldOn: dayOf(now) };
      }
      case 'HOSTEL': {
        const hostel = await this.prisma.hostel.findFirst({ where: { venueId: reader.venueId } });
        if (!hostel) return { context, denial: { reason: REASON_CODES.READER_SERVICE_MISMATCH, message: 'This reader is not installed at a hostel.' } };
        context.hostel_code = hostel.code;
        return { context };
      }
      case 'CAFETERIA': {
        const sittings = await this.prisma.mealSitting.findMany({ where: { serviceId: reader.serviceId }, orderBy: { startsAt: 'asc' } });
        const at = nowMinutes(now);
        const sitting = sittings.find((s) => at >= minutes(s.startsAt) && at <= minutes(s.endsAt));
        if (!sitting) return { context, denial: { reason: REASON_CODES.OUTSIDE_TIME_WINDOW, message: 'No meal is being served right now.' } };
        context.meal_type = sitting.mealType;
        context.sitting_id = sitting.id;
        return { context };
      }
      default:
        if (hint?.courseUnitCode) context.course_unit = hint.courseUnitCode;
        return { context };
    }
  }

  /**
   * Claims the exclusive right to this grant. Runs only after the rules said yes. Both claims are single atomic
   * database operations (unique key / conditional update), so two simultaneous scans cannot both succeed.
   */
  async claim(reader: ReaderContext, studentId: string, direction: 'ENTRY' | 'EXIT' | undefined, now: Date, prep: Prep): Promise<Denial | null> {
    if (reader.serviceCode === 'CAFETERIA') {
      try {
        const usage = await this.prisma.mealUsage.create({ data: { studentId, sittingId: String(prep.context.sitting_id), servedOn: dayOf(now) } });
        prep.mealUsageId = usage.id;
        return null;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') return { reason: REASON_CODES.MEAL_ALREADY_CLAIMED, message: `${String(prep.context.meal_type).toLowerCase()} already served to this student today.` };
        throw e;
      }
    }

    const service = await this.prisma.service.findUnique({ where: { id: reader.serviceId }, select: { requiresDirection: true } });
    if (!service?.requiresDirection) return null;

    if (!direction) {
      const policy = await this.facts.policy();
      return policy.gate_direction_required === true
        ? { reason: REASON_CODES.DIRECTION_REQUIRED, message: 'Select ENTRY or EXIT on the reader.' }
        : null; // policy unconfirmed: unspecified direction is not tracked (documented in DECISIONS D-035)
    }
    const zone = reader.serviceCode;
    if (direction === 'EXIT') {
      await this.prisma.presenceState.upsert({ where: { studentId_zone: { studentId, zone } }, update: { direction: 'EXIT', at: now }, create: { studentId, zone, direction: 'EXIT', at: now } });
      return null;
    }
    // ENTRY: only valid if the last recorded movement was not already an ENTRY (anti-passback).
    const first = await this.prisma.presenceState.createMany({ data: [{ studentId, zone, direction: 'ENTRY', at: now }], skipDuplicates: true });
    if (first.count === 1) return null;
    const moved = await this.prisma.presenceState.updateMany({ where: { studentId, zone, direction: { not: 'ENTRY' } }, data: { direction: 'ENTRY', at: now } });
    return moved.count === 1 ? null : { reason: REASON_CODES.ANTI_PASSBACK, message: 'Already inside: an EXIT must be recorded before entering again.' };
  }

  /** Records the outcome in the same transaction as the access log. */
  async finalize(tx: Prisma.TransactionClient, logId: string, studentId: string, prep: Prep): Promise<void> {
    if (prep.scheduleId && prep.heldOn) {
      // Unique (schedule, student, day): one attendance row however many times (or by which credential) the student scans.
      await tx.lectureAttendance.upsert({
        where: { scheduleId_studentId_heldOn: { scheduleId: prep.scheduleId, studentId, heldOn: prep.heldOn } },
        update: {}, create: { scheduleId: prep.scheduleId, studentId, heldOn: prep.heldOn },
      });
    }
    if (prep.mealUsageId) await tx.mealUsage.update({ where: { id: prep.mealUsageId }, data: { accessLogId: logId } });
  }
}
