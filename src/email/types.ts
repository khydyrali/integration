export interface EmailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
  /** Set to reference the attachment inline as <img src="cid:...">. */
  contentId?: string;
}

export interface OutgoingEmail {
  /** Our emails.id; doubles as the provider idempotency key. */
  id: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
  attachments: EmailAttachment[];
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutgoingEmail): Promise<{ messageId: string }>;
}
