import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import { HttpError } from '../../lib/http.js';
import type { EmailProvider, OutgoingEmail } from '../types.js';

const THROTTLE_ERRORS = new Set(['TooManyRequestsException', 'LimitExceededException', 'ThrottlingException']);

/** Amazon SES v2. Credentials come from the default AWS provider chain. */
export class SesProvider implements EmailProvider {
  readonly name = 'ses';
  private readonly client: SESv2Client;
  // Builds the raw MIME message (attachments, inline images) without sending it.
  private readonly mime = nodemailer.createTransport({ streamTransport: true, buffer: true });

  constructor(region: string, private readonly configurationSet?: string) {
    this.client = new SESv2Client({ region });
  }

  async send(msg: OutgoingEmail): Promise<{ messageId: string }> {
    const built = await this.mime.sendMail({
      from: msg.from,
      to: msg.to,
      replyTo: msg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType,
        cid: a.contentId,
      })),
    });

    try {
      const res = await this.client.send(
        new SendEmailCommand({
          Content: { Raw: { Data: built.message as Buffer } },
          ConfigurationSetName: this.configurationSet,
          EmailTags: [{ Name: 'email_id', Value: msg.id }],
        }),
      );
      return { messageId: res.MessageId ?? '' };
    } catch (err) {
      // Normalise AWS errors so retry/failover logic can classify them like any HTTP error.
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      const status = THROTTLE_ERRORS.has(e.name ?? '') ? 429 : e.$metadata?.httpStatusCode;
      if (status) throw new HttpError(status, e.name, `SES ${e.name}: ${e.message}`);
      throw err;
    }
  }
}
