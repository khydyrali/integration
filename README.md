# mn-integrations

A small Node.js/TypeScript service covering:

1. **QPay v2**: invoices with QR codes and bank deeplinks, payment verification, cancellation and refunds.
2. **Ebarimt 3.0 (PosAPI)**: automatic e-receipts (B2C/B2B) with VAT and НХАТ calculation, voided on refund.
3. **Reliable transactional email**: a durable outbox, retries with backoff, provider failover (Resend → SES), idempotency, and a bounce/complaint suppression list.

```
POST /orders ──► QPay invoice ──► customer pays ──► QPay callback / reconciler
                                                      │  (verified via /v2/payment/check)
                                                      ▼
                                       order PAID ──► job: ebarimt.issue ──► PosAPI /rest/receipt
                                                                              │
                                                                              ▼
                                                             job: email.send (receipt + QR)
```

Every side effect runs as a row in the `jobs` table, written in the **same transaction** as the state change that caused it. A crash, a deploy, or an outage at QPay, PosAPI or the email provider therefore never loses a receipt or an email. Failed jobs retry with exponential backoff (5s → 1h). Jobs that exhaust their retries appear in `GET /jobs?status=dead` and can be re-run with `POST /jobs/:id/retry`.

## Running

Requires Node ≥ 20 and PostgreSQL ≥ 13.

```bash
cp .env.example .env          # fill in values
docker compose up -d postgres
npm install
npm run dev                   # migrations run automatically on boot
```

`ROLE=api` / `ROLE=worker` splits the HTTP server and the background worker into separate processes. You can run several workers; they coordinate with `FOR UPDATE SKIP LOCKED`.

## API

All endpoints except `/health` and `/webhooks/*` require the header `x-api-key: $API_KEY`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/orders` | Create an order and its QPay invoice; returns the QR image, QR text and deeplinks |
| GET | `/orders/:id` | Order status, including the ebarimt receipt (lottery number, QR) once issued |
| POST | `/orders/:id/check` | Ask QPay now; poll this from the checkout page |
| POST | `/orders/:id/cancel` | Cancel an unpaid invoice |
| POST | `/orders/:id/refund` | Refund through QPay and void the ebarimt receipt |
| GET | `/ebarimt/info` | PosAPI status (registration, last sync, remaining lottery numbers) |
| POST | `/ebarimt/send-data` | Force a PosAPI sync to the central system |
| GET | `/ebarimt/taxpayers/:regNo` | Look up a company TIN and name (for B2B receipts) |
| POST | `/emails` | Send any transactional email (`to`, `subject`, `html`/`text`, `idempotencyKey`) |
| GET | `/emails/:id` | Delivery status |
| GET | `/jobs?status=dead` | Inspect failed jobs |
| POST | `/jobs/:id/retry` | Re-run a dead job |
| GET/POST | `/webhooks/qpay/:orderId` | QPay callback (signed URL) |
| POST | `/webhooks/resend` | Resend delivery events (Svix-signed) |

Example order:

```json
POST /orders
{
  "reference": "shop-order-1042",
  "description": "Order #1042",
  "customerEmail": "bat@example.mn",
  "items": [
    { "name": "Americano", "qty": 2, "unitPrice": 5600, "classificationCode": "2349010", "cityTax": true },
    { "name": "Book", "qty": 1, "unitPrice": 20000, "classificationCode": "4761000",
      "taxType": "VAT_FREE", "taxProductCode": "305" }
  ]
}
```

Prices include tax. Add `customerRegNo` (or `customerTin`) to issue a B2B receipt, or `consumerNo` to send a B2C receipt to an individual's ebarimt account. `reference` makes the request idempotent: posting the same reference again returns the existing order.

## QPay notes

- The callback is only a hint. The service always confirms through `/v2/payment/check` and marks an order PAID only once, so duplicate callbacks are harmless.
- Callback URLs are HMAC-signed per order, so nobody can trigger checks on arbitrary orders.
- If a callback never arrives, a reconciler re-checks pending orders every 30 seconds for 24 hours.
- Sandbox: `https://merchant-sandbox.qpay.mn`, `TEST_MERCHANT` / `123456`, invoice code `TEST_INVOICE`.

## Ebarimt notes

- Install and register the **PosAPI 3.0** service from the operator first. It runs locally (default `http://localhost:7080`) and needs your merchant TIN and POS number.
- Every item needs a БҮНА `classificationCode`. `VAT_FREE` / `VAT_ZERO` items also need a `taxProductCode`.
- VAT is 10%, taken out of the tax-inclusive price. НХАТ uses `EBARIMT_CITY_TAX_RATE` on items marked `cityTax: true`. **Confirm the rate and which items it applies to with your accountant.**
- QPay payments are reported to PosAPI as `PAYMENT_CARD` (non-cash).
- A refund voids the receipt through `DELETE /rest/receipt`.

## Email deliverability checklist

Code only gets mail delivered reliably if DNS and the sender domain are set up too:

1. Send from a **subdomain** (`mail.your-domain.mn`) so transactional reputation is kept separate from marketing mail.
2. Publish **SPF**, **DKIM** (both Resend and SES give you the records) and **DMARC** (`v=DMARC1; p=quarantine; rua=mailto:…`).
3. Configure the Resend webhook → `https://…/webhooks/resend` for `email.delivered`, `email.bounced` and `email.complained`, and put its signing secret in `RESEND_WEBHOOK_SECRET`. Hard bounces and complaints add the address to `email_suppressions`, and the service stops mailing it.
4. For the SES fallback, verify the same domain in SES, request production access (leave the sandbox), and set `SES_CONFIGURATION_SET` if you want SNS bounce events.
5. Always send a plain-text part. Templates already include one.

Failover only happens when a provider clearly did not accept the message (connection error, 429, 5xx). After a timeout the service retries the *same* provider; Resend dedupes on our idempotency key, so a retry can't produce a duplicate email.

## Tests

```bash
npm test        # tax/receipt math, webhook signature verification, URL signing
npm run typecheck
```
