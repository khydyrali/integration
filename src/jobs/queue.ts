import type { Queryable } from '../db.js';

/** Throw from a job handler to skip remaining retries. */
export class PermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

export interface EnqueueOptions {
  /** Second enqueue with the same key is a no-op. */
  idempotencyKey?: string;
  maxAttempts?: number;
  runAt?: Date;
}

/** Pass a transaction client so the job commits atomically with the state change that caused it. */
export async function enqueue(db: Queryable, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
  await db.query(
    `INSERT INTO jobs (type, payload, idempotency_key, max_attempts, run_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [type, JSON.stringify(payload), opts.idempotencyKey ?? null, opts.maxAttempts ?? 10, opts.runAt ?? null],
  );
}
