import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db.js';
import { PermanentError } from './queue.js';

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

export interface JobHandler {
  run(payload: any, job: Job): Promise<void>;
  /** Called once when the job exhausts its retries or fails permanently. */
  onDead?(payload: any, error: string): Promise<void>;
}

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  /** A running job older than this is assumed to belong to a crashed worker. */
  staleAfterMs?: number;
}

export function backoffMs(attempt: number): number {
  const base = Math.min(5_000 * 2 ** (attempt - 1), 3_600_000);
  return base + Math.floor(Math.random() * base * 0.2);
}

export class JobWorker {
  private running = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly staleAfterMs: number;

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly log: FastifyBaseLogger,
    opts: WorkerOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 5;
    this.pollMs = opts.pollMs ?? 1_000;
    this.staleAfterMs = opts.staleAfterMs ?? 5 * 60_000;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.running]);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (err) {
      this.log.error({ err }, 'job worker tick failed');
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.pollMs);
  }

  private async tick(): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'pending', locked_at = NULL, updated_at = now()
       WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
      [this.staleAfterMs / 1000],
    );

    const free = this.concurrency - this.running.size;
    if (free <= 0) return;

    const { rows } = await this.db.query<Job>(
      `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
         ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, type, payload, attempts, max_attempts`,
      [free],
    );

    for (const job of rows) {
      const p = this.execute(job).finally(() => this.running.delete(p));
      this.running.add(p);
    }
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    const log = this.log.child({ jobId: job.id, jobType: job.type, attempt: job.attempts });
    try {
      if (!handler) throw new PermanentError(`no handler for job type ${job.type}`);
      await handler.run(job.payload, job);
      await this.db.query(`UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
      log.info('job done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = err instanceof PermanentError || job.attempts >= job.max_attempts;
      if (dead) {
        await this.db.query(`UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2, updated_at = now() WHERE id = $1`, [job.id, message]);
        log.error({ err }, 'job dead');
        await handler?.onDead?.(job.payload, message).catch((e) => log.error({ err: e }, 'onDead failed'));
      } else {
        const delay = backoffMs(job.attempts);
        await this.db.query(
          `UPDATE jobs SET status = 'pending', locked_at = NULL, last_error = $2,
             run_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
          [job.id, message, delay / 1000],
        );
        log.warn({ err, retryInMs: delay }, 'job failed, will retry');
      }
    }
  }
}
