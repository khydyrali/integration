import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    /** api = HTTP only, worker = background jobs only, all = both in one process */
    ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    PUBLIC_BASE_URL: z.string().url(),
    DATABASE_URL: z.string().min(1),
    /** Used to sign QPay callback URLs. */
    APP_SECRET: z.string().min(32),
    /** Clients must send this in the x-api-key header. */
    API_KEY: z.string().min(24),

    QPAY_BASE_URL: z.string().url().default('https://merchant.qpay.mn'),
    QPAY_CLIENT_ID: z.string().min(1),
    QPAY_CLIENT_SECRET: z.string().min(1),
    QPAY_INVOICE_CODE: z.string().min(1),

    EBARIMT_POSAPI_URL: z.string().url().default('http://localhost:7080'),
    EBARIMT_API_URL: z.string().url().default('https://api.ebarimt.mn'),
    EBARIMT_MERCHANT_TIN: z.string().min(1),
    EBARIMT_POS_NO: z.string().min(1),
    EBARIMT_BRANCH_NO: z.string().min(1).default('001'),
    EBARIMT_DISTRICT_CODE: z.string().min(4),
    EBARIMT_VAT_PAYER: bool.default('true'),
    /** НХАТ rate (e.g. 0.01 or 0.02). Applied only to items flagged cityTax=true. */
    EBARIMT_CITY_TAX_RATE: z.coerce.number().min(0).max(0.1).default(0),

    EMAIL_FROM: z.string().min(3),
    EMAIL_REPLY_TO: z.string().optional(),
    /** Ordered list; later providers are used as failover. */
    EMAIL_PROVIDERS: z
      .string()
      .default('resend')
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.enum(['resend', 'ses'])).min(1)),
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    AWS_REGION: z.string().optional(),
    SES_CONFIGURATION_SET: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.EMAIL_PROVIDERS.includes('resend') && !c.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required when resend is enabled' });
    }
    if (c.EMAIL_PROVIDERS.includes('ses') && !c.AWS_REGION) {
      ctx.addIssue({ code: 'custom', path: ['AWS_REGION'], message: 'required when ses is enabled' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
