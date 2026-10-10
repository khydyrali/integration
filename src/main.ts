import 'dotenv/config';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { EbarimtPublicApi, PosApiClient } from './ebarimt/client.js';
import { ResendProvider } from './email/providers/resend.js';
import { SesProvider } from './email/providers/ses.js';
import { FailoverSender } from './email/sender.js';
import { EmailService } from './email/service.js';
import type { EmailProvider } from './email/types.js';
import { buildServer } from './http/server.js';
import { createJobHandlers } from './jobs/handlers.js';
import { JobWorker } from './jobs/worker.js';
import { migrate } from './migrate.js';
import { OrderService } from './orders/service.js';
import { QPayClient } from './qpay/client.js';

const config = loadConfig();
const app = Fastify({
  logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers["x-api-key"]', 'req.headers.authorization'] },
});
const log = app.log;
const db = createPool(config.DATABASE_URL);

await migrate(db, (m) => log.info(m));

const qpay = new QPayClient({
  baseUrl: config.QPAY_BASE_URL,
  clientId: config.QPAY_CLIENT_ID,
  clientSecret: config.QPAY_CLIENT_SECRET,
});
const posApi = new PosApiClient(config.EBARIMT_POSAPI_URL);
const ebarimtApi = new EbarimtPublicApi(config.EBARIMT_API_URL);

const providers: EmailProvider[] = config.EMAIL_PROVIDERS.map((name) =>
  name === 'resend' ? new ResendProvider(config.RESEND_API_KEY!) : new SesProvider(config.AWS_REGION!, config.SES_CONFIGURATION_SET),
);
const email = new EmailService(db, new FailoverSender(providers, log), { from: config.EMAIL_FROM, replyTo: config.EMAIL_REPLY_TO });
const orders = new OrderService(db, qpay, ebarimtApi, config, log);

let worker: JobWorker | undefined;
let reconcileTimer: NodeJS.Timeout | undefined;

if (config.ROLE !== 'worker') {
  buildServer({ config, db, orders, posApi, ebarimtApi, email }, app);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

if (config.ROLE !== 'api') {
  worker = new JobWorker(db, createJobHandlers({ db, config, orders, posApi, email }), log.child({ component: 'worker' }));
  worker.start();
  reconcileTimer = setInterval(() => void orders.reconcilePending(), 30_000);
  log.info('job worker started');
}

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  clearInterval(reconcileTimer);
  await app.close();
  await worker?.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
