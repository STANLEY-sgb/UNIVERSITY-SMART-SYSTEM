import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { AlertSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsService } from '../events/events.module';

export interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  readerId?: string | null;
  studentId?: string | null;
  cardId?: string | null;
  detail?: Record<string, unknown>;
}

@Injectable()
export class AlertsService {
  private readonly log = new Logger('SecurityAlert');
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  /** Never throws: raising an alert must not change the access decision that triggered it. */
  async raise(a: AlertInput): Promise<void> {
    try {
      await this.prisma.securityAlert.create({
        data: {
          kind: a.kind, severity: a.severity, readerId: a.readerId ?? null, studentId: a.studentId ?? null,
          cardId: a.cardId ?? null, detail: (a.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
      this.log.warn(`${a.severity} ${a.kind}`);
      this.events.publish({ type: 'alert', kind: a.kind, severity: a.severity, at: new Date().toISOString() });
    } catch (e) {
      this.log.error(`Failed to record alert ${a.kind}: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [AlertsService], exports: [AlertsService] })
export class AlertsModule {}
