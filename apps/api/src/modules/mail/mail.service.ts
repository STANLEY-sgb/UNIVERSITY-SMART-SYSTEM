import { Global, Injectable, Logger, Module } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail adapter. The prototype ships only a development transport that records messages
 * in memory and logs them (never in production). A real SMTP/SMS adapter plugs in here.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 200) this.outbox.shift();
    if (process.env.NODE_ENV !== 'production') {
      this.log.warn(`[DEV MAIL] to=${message.to} subject="${message.subject}"`);
    }
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
