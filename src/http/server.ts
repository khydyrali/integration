import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { EbarimtPublicApi, PosApiClient } from '../ebarimt/client.js';
import type { EmailService, ResendEvent } from '../email/service.js';
import { verifySvixSignature } from '../email/webhook.js';
import { HttpError } from '../lib/http.js';
import { verifySignedValue } from '../lib/signing.js';
import { createOrderSchema, OrderError, type OrderRow, type OrderService } from '../orders/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface ServerDeps {
  config: Config;
  db: Db;
  orders: OrderService;
  posApi: PosApiClient;
  ebarimtApi: EbarimtPublicApi;
  email: EmailService;
}

const idParams = z.object({ id: z.string().uuid() });

const sendEmailSchema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    html: z.string().optional(),
    text: z.string().optional(),
    replyTo: z.string().email().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .refine((e) => e.html || e.text, { message: 'html or text is required' });

function present(o: OrderRow) {
  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    description: o.description,
    amount: o.amount,
    paidAmount: o.paid_amount,
    paidAt: o.paid_at,
    createdAt: o.created_at,
    qpay: o.qpay_invoice && {
      invoiceId: o.qpay_invoice.invoice_id,
      qrText: o.qpay_invoice.qr_text,
      qrImage: o.qpay_invoice.qr_image,
      shortUrl: o.qpay_invoice.qPay_shortUrl,
      deeplinks: o.qpay_invoice.urls,
    },
    ebarimt: o.ebarimt_id && {
      id: o.ebarimt_id,
      lottery: o.ebarimt_lottery,
      qrData: o.ebarimt_qr_data,
      date: o.ebarimt_date,
      returnedAt: o.ebarimt_returned_at,
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer(deps: ServerDeps, app: FastifyInstance = Fastify({ logger: true })): FastifyInstance {
  const { config, db, orders, posApi, ebarimtApi, email } = deps;

  // Keep the raw body: webhook signatures are computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  // QPay callbacks may arrive with an arbitrary content type; we ignore the body anyway.
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, body);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_error', issues: err.issues });
    if (err instanceof OrderError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof HttpError) {
      req.log.error({ err, upstream: err.body }, 'upstream error');
      return reply.code(502).send({ error: 'upstream_error', status: err.status, detail: err.body });
    }
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(statusCode).send({ error: statusCode >= 500 ? 'internal_error' : (err as Error).message });
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ---- Public webhooks -------------------------------------------------------

  app.route({
    method: ['GET', 'POST'],
    url: '/webhooks/qpay/:orderId',
    handler: async (req: FastifyRequest<{ Params: { orderId: string }; Querystring: { token?: string } }>, reply) => {
      const { orderId } = req.params;
      if (!z.string().uuid().safeParse(orderId).success || !verifySignedValue(config.APP_SECRET, orderId, req.query.token)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      try {
        await orders.checkPayment(orderId);
      } catch (err) {
        // The reconciler will pick it up; acknowledge so QPay doesn't hammer us.
        req.log.error({ err, orderId }, 'qpay callback: payment check failed');
      }
      return reply.code(200).send('SUCCESS');
    },
  });

  app.post('/webhooks/resend', async (req, reply) => {
    if (!config.RESEND_WEBHOOK_SECRET) return reply.code(404).send();
    const ok = verifySvixSignature(
      config.RESEND_WEBHOOK_SECRET,
      {
        id: req.headers['svix-id'] as string | undefined,
        timestamp: req.headers['svix-timestamp'] as string | undefined,
        signature: req.headers['svix-signature'] as string | undefined,
      },
      req.rawBody ?? '',
    );
    if (!ok) return reply.code(401).send({ error: 'invalid signature' });
    await email.handleResendEvent(req.body as ResendEvent);
    return { ok: true };
  });

  // ---- Authenticated API -----------------------------------------------------

  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      const key = req.headers['x-api-key'];
      if (typeof key !== 'string' || !safeEqual(key, config.API_KEY)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    });

    api.post('/orders', async (req, reply) => {
      const order = await orders.create(createOrderSchema.parse(req.body));
      return reply.code(201).send(present(order));
    });

    api.get('/orders/:id', async (req, reply) => {
      const order = await orders.get(idParams.parse(req.params).id);
      return order ? present(order) : reply.code(404).send({ error: 'not found' });
    });

    /** Poll this from the checkout page while the customer pays. */
    api.post('/orders/:id/check', async (req, reply) => {
      const order = await orders.checkPayment(idParams.parse(req.params).id);
      return order ? present(order) : reply.code(404).send({ error: 'not found' });
    });

    api.post('/orders/:id/cancel', async (req, reply) => {
      const order = await orders.cancel(idParams.parse(req.params).id);
      return order ? present(order) : reply.code(404).send({ error: 'not found' });
    });

    api.post('/orders/:id/refund', async (req, reply) => {
      const { note } = z.object({ note: z.string().max(255).optional() }).parse(req.body ?? {});
      const order = await orders.refund(idParams.parse(req.params).id, note);
      return order ? present(order) : reply.code(404).send({ error: 'not found' });
    });

    api.get('/ebarimt/info', () => posApi.info());
    api.post('/ebarimt/send-data', () => posApi.sendData());

    api.get('/ebarimt/taxpayers/:regNo', async (req) => {
      const { regNo } = z.object({ regNo: z.string().min(1) }).parse(req.params);
      const tin = await ebarimtApi.tinByRegNo(regNo);
      return { tin, ...(await ebarimtApi.taxpayerInfo(tin)) };
    });

    api.post('/emails', async (req, reply) => {
      const id = await email.queue(sendEmailSchema.parse(req.body));
      return reply.code(202).send({ id });
    });

    api.get('/emails/:id', async (req, reply) => {
      const row = await email.get(idParams.parse(req.params).id);
      return row ?? reply.code(404).send({ error: 'not found' });
    });

    api.get('/jobs', async (req) => {
      const { status } = z.object({ status: z.enum(['pending', 'running', 'done', 'dead']).default('dead') }).parse(req.query);
      const { rows } = await db.query(
        `SELECT id, type, payload, status, attempts, max_attempts, run_at, last_error, updated_at
         FROM jobs WHERE status = $1 ORDER BY updated_at DESC LIMIT 100`,
        [status],
      );
      return rows;
    });

    api.post('/jobs/:id/retry', async (req, reply) => {
      const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
      const { rowCount } = await db.query(
        `UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), updated_at = now() WHERE id = $1 AND status = 'dead'`,
        [id],
      );
      // A failed email is re-queued along with its job.
      await db.query(
        `UPDATE emails SET status = 'queued', updated_at = now()
         WHERE status = 'failed' AND id = (SELECT (payload->>'emailId')::uuid FROM jobs WHERE id = $1 AND type = 'email.send')`,
        [id],
      );
      return rowCount ? { ok: true } : reply.code(404).send({ error: 'no dead job with that id' });
    });
  });

  return app;
}
