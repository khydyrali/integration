import type { FastifyBaseLogger } from 'fastify';
import { PermanentError } from '../jobs/queue.js';
import { isRetryable, isTimeout } from '../lib/http.js';
import type { EmailProvider, OutgoingEmail } from './types.js';

/**
 * Tries providers in order. Fails over only when the request clearly was not accepted
 * (connection error, 429, 5xx). On a timeout the first provider might have accepted the
 * message, so we retry later instead of risking a duplicate via a second provider.
 */
export class FailoverSender {
  constructor(
    private readonly providers: EmailProvider[],
    private readonly log: FastifyBaseLogger,
  ) {
    if (providers.length === 0) throw new Error('at least one email provider is required');
  }

  async send(msg: OutgoingEmail): Promise<{ provider: string; messageId: string }> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        const { messageId } = await provider.send(msg);
        return { provider: provider.name, messageId };
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) {
          throw new PermanentError(`${provider.name} rejected email: ${(err as Error).message}`, { cause: err });
        }
        if (isTimeout(err)) throw err;
        this.log.warn({ err, provider: provider.name, emailId: msg.id }, 'email provider failed, trying next');
      }
    }
    throw lastError;
  }
}
