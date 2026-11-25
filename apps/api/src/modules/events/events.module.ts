import { Controller, Global, Injectable, MessageEvent, Module, ServiceUnavailableException, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Observable, Subject, finalize, interval, map, merge } from 'rxjs';
import { RequirePermissions } from '../../common/decorators';

/** Deliberately small and free of personal data: the console re-queries what it is allowed to see. */
export type LiveEvent =
  | { type: 'decision'; decision: 'GRANT' | 'DENY'; service: string; offline: boolean; at: string }
  | { type: 'alert'; kind: string; severity: string; at: string };

export const MAX_STREAMS = 200;
export const HEARTBEAT_MS = 25_000;

@Injectable()
export class EventsService {
  private readonly bus = new Subject<LiveEvent>();
  private open = 0;

  publish(e: LiveEvent): void { this.bus.next(e); }

  /** One SSE stream: events plus a heartbeat comment-like ping so proxies keep the connection open. */
  stream(): Observable<MessageEvent> {
    if (this.open >= MAX_STREAMS) throw new ServiceUnavailableException({ code: 'TOO_MANY_STREAMS', message: 'Too many live connections. Try again shortly.' });
    this.open++;
    const events = this.bus.pipe(map((e): MessageEvent => ({ type: e.type, data: e })));
    const ping = interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })));
    return merge(events, ping).pipe(finalize(() => { this.open--; }));
  }

  get streams(): number { return this.open; }
}

@ApiTags('events')
@ApiBearerAuth() @ApiCookieAuth()
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Server-sent events for the console dashboard. Needs the same permission as the dashboard itself. */
  @RequirePermissions('reports.view')
  @Sse('events')
  stream(): Observable<MessageEvent> { return this.events.stream(); }
}

@Global()
@Module({ providers: [EventsService], controllers: [EventsController], exports: [EventsService] })
export class EventsModule {}
