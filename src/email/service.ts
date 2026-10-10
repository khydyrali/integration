import { tx, type Db, type Queryable } from '../db.js';
import { enqueue } from '../jobs/queue.js';
import type { FailoverSender } from './sender.js';
import type { EmailAttachment } from './types.js';

export interface EmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Same key → same email, never sent twice. */
  idempotencyKey?: string;
}

interface EmailRow {
  id: string;
  status: string;
  from_email: string;
  to_email: string;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  attachments: EmailAttachment[];
}

export interface ResendEvent {
  type: string;
  data: { email_id?: string; to?: string[]; bounce?: { type?: string; message?: string } };
}

export class EmailService {
  constructor(
    private readonly db: Db,
    private readonly sender: FailoverSender,
    private readonly defaults: { from: string; replyTo?: string },
  ) {}

  /** Stores the email and schedules delivery. Pass a transaction client to commit with other changes. */
  async queue(input: EmailInput, client?: Queryable): Promise<string> {
    if (!client) return tx(this.db, (c) => this.queue(input, c));

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO emails (idempotency_key, from_email, to_email, reply_to, subject, html, text, attachments)
       VALUES ($1, $2, lower($3), $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        input.idempotencyKey ?? null,
        input.from ?? this.defaults.from,
        input.to,
        input.replyTo ?? this.defaults.replyTo ?? null,
        input.subject,
        input.html ?? null,
        input.text ?? null,
        JSON.stringify(input.attachments ?? []),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      const existing = await client.query<{ id: string }>('SELECT id FROM emails WHERE idempotency_key = $1', [input.idempotencyKey]);
      return existing.rows[0]!.id;
    }
    await enqueue(client, 'email.send', { emailId: id }, { idempotencyKey: `email.send:${id}`, maxAttempts: 12 });
    return id;
  }

  get(id: string) {
    return this.db
      .query(
        `SELECT id, status, to_email, subject, provider, provider_message_id, last_error, sent_at, created_at
         FROM emails WHERE id = $1`,
        [id],
      )
      .then((r) => r.rows[0]);
  }

  async deliver(emailId: string): Promise<void> {
    const { rows } = await this.db.query<EmailRow>('SELECT * FROM emails WHERE id = $1', [emailId]);
    const email = rows[0];
    if (!email || email.status !== 'queued') return;

    const suppressed = await this.db.query('SELECT 1 FROM email_suppressions WHERE email = $1', [email.to_email]);
    if (suppressed.rowCount) {
      await this.setStatus(emailId, 'suppressed', 'recipient is on the suppression list');
      return;
    }

    try {
      const res = await this.sender.send({
        id: email.id,
        from: email.from_email,
        to: email.to_email,
        replyTo: email.reply_to ?? undefined,
        subject: email.subject,
        html: email.html ?? undefined,
        text: email.text ?? undefined,
        attachments: email.attachments,
      });
      await this.db.query(
        `UPDATE emails SET status = 'sent', provider = $2, provider_message_id = $3, last_error = NULL,
           sent_at = now(), updated_at = now() WHERE id = $1`,
        [emailId, res.provider, res.messageId],
      );
    } catch (err) {
      await this.db.query('UPDATE emails SET last_error = $2, updated_at = now() WHERE id = $1', [emailId, (err as Error).message]);
      throw err;
    }
  }

  markFailed(emailId: string, error: string): Promise<void> {
    return this.setStatus(emailId, 'failed', error);
  }

  async handleResendEvent(event: ResendEvent): Promise<void> {
    const messageId = event.data.email_id;
    const recipients = (event.data.to ?? []).map((t) => t.toLowerCase());

    const status = (
      {
        'email.delivered': 'delivered',
        'email.bounced': 'bounced',
        'email.complained': 'complained',
      } as Record<string, string>
    )[event.type];
    if (status && messageId) {
      await this.db.query('UPDATE emails SET status = $2, updated_at = now() WHERE provider_message_id = $1', [messageId, status]);
    }

    const permanentBounce = event.type === 'email.bounced' && event.data.bounce?.type !== 'Transient';
    if (permanentBounce || event.type === 'email.complained') {
      for (const email of recipients) {
        await this.db.query(
          'INSERT INTO email_suppressions (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
          [email, event.type],
        );
      }
    }
  }

  private async setStatus(emailId: string, status: string, error: string | null): Promise<void> {
    await this.db.query('UPDATE emails SET status = $2, last_error = $3, updated_at = now() WHERE id = $1', [emailId, status, error]);
  }
}
