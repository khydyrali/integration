import { request } from '../../lib/http.js';
import type { EmailProvider, OutgoingEmail } from '../types.js';

export class ResendProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(private readonly apiKey: string) {}

  async send(msg: OutgoingEmail): Promise<{ messageId: string }> {
    const res = await request<{ id: string }>('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        // Resend dedupes retries with the same key for 24h, so a retry after a timeout won't double-send.
        'idempotency-key': msg.id,
      },
      body: {
        from: msg.from,
        to: [msg.to],
        reply_to: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments.map((a) => ({
          filename: a.filename,
          content: a.contentBase64,
          content_type: a.contentType,
          content_id: a.contentId,
        })),
        tags: [{ name: 'email_id', value: msg.id }],
      },
      timeoutMs: 15_000,
    });
    return { messageId: res.id };
  }
}
