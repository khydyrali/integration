CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text UNIQUE,
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'PAID', 'REFUNDED', 'CANCELLED', 'FAILED')),
  description         text NOT NULL,
  amount              numeric(14, 2) NOT NULL CHECK (amount > 0),
  paid_amount         numeric(14, 2),
  items               jsonb NOT NULL,
  customer_email      text,
  customer_tin        text,
  consumer_no         text,
  qpay_invoice_id     text UNIQUE,
  qpay_invoice        jsonb,
  qpay_payment_id     text,
  paid_at             timestamptz,
  last_checked_at     timestamptz,
  ebarimt_id          text,
  ebarimt_lottery     text,
  ebarimt_qr_data     text,
  ebarimt_date        text,
  ebarimt_response    jsonb,
  ebarimt_returned_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_pending_idx ON orders (created_at) WHERE status = 'PENDING';

-- Durable job queue (transactional outbox). Workers claim rows with SKIP LOCKED.
CREATE TABLE jobs (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 10,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  last_error      text,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'pending';

CREATE TABLE emails (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     text UNIQUE,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  from_email          text NOT NULL,
  to_email            text NOT NULL,
  reply_to            text,
  subject             text NOT NULL,
  html                text,
  text                text,
  attachments         jsonb NOT NULL DEFAULT '[]',
  provider            text,
  provider_message_id text,
  last_error          text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emails_provider_msg_idx ON emails (provider_message_id);

-- Addresses that hard-bounced or complained. Sending to them hurts domain reputation.
CREATE TABLE email_suppressions (
  email      text PRIMARY KEY,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
