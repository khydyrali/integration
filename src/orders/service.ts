import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { tx, type Db } from '../db.js';
import type { EbarimtPublicApi } from '../ebarimt/client.js';
import { orderItemSchema, orderTotal, type OrderItem } from '../ebarimt/receipt.js';
import { enqueue } from '../jobs/queue.js';
import { signValue } from '../lib/signing.js';
import type { QPayClient } from '../qpay/client.js';
import type { QPayInvoiceResponse } from '../qpay/types.js';

export const createOrderSchema = z
  .object({
    /** Your own order id. Re-posting the same reference returns the existing order. */
    reference: z.string().min(1).max(100).optional(),
    description: z.string().min(1).max(255),
    items: z.array(orderItemSchema).min(1),
    customerEmail: z.string().email().optional(),
    /** For a B2B receipt: either the company TIN, or its registration number (resolved to a TIN). */
    customerTin: z.string().min(1).optional(),
    customerRegNo: z.string().min(1).optional(),
    /** Individual's ebarimt consumer number, for a B2C receipt sent to their account. */
    consumerNo: z.string().min(1).optional(),
  })
  .refine((o) => !(o.customerTin && o.customerRegNo), { message: 'pass customerTin or customerRegNo, not both' });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export type OrderStatus = 'PENDING' | 'PAID' | 'REFUNDED' | 'CANCELLED' | 'FAILED';

export interface OrderRow {
  id: string;
  reference: string | null;
  status: OrderStatus;
  description: string;
  amount: number;
  paid_amount: number | null;
  items: OrderItem[];
  customer_email: string | null;
  customer_tin: string | null;
  consumer_no: string | null;
  qpay_invoice_id: string | null;
  qpay_invoice: QPayInvoiceResponse | null;
  qpay_payment_id: string | null;
  paid_at: Date | null;
  ebarimt_id: string | null;
  ebarimt_lottery: string | null;
  ebarimt_qr_data: string | null;
  ebarimt_date: string | null;
  ebarimt_returned_at: Date | null;
  created_at: Date;
}

export class OrderError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly qpay: QPayClient,
    private readonly ebarimtApi: EbarimtPublicApi,
    private readonly config: Config,
    private readonly log: FastifyBaseLogger,
  ) {}

  async get(id: string): Promise<OrderRow | undefined> {
    const { rows } = await this.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    return rows[0];
  }

  async create(input: CreateOrderInput): Promise<OrderRow> {
    if (input.reference) {
      const { rows } = await this.db.query<OrderRow>('SELECT * FROM orders WHERE reference = $1', [input.reference]);
      if (rows[0]) return rows[0];
    }

    const customerTin = input.customerRegNo ? await this.ebarimtApi.tinByRegNo(input.customerRegNo) : input.customerTin;
    const amount = orderTotal(input.items);
    if (amount <= 0) throw new OrderError('order total must be greater than zero', 400);

    const inserted = await this.db.query<OrderRow>(
      `INSERT INTO orders (reference, description, amount, items, customer_email, customer_tin, consumer_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (reference) DO NOTHING RETURNING *`,
      [
        input.reference ?? null,
        input.description,
        amount,
        JSON.stringify(input.items),
        input.customerEmail ?? null,
        customerTin ?? null,
        input.consumerNo ?? null,
      ],
    );
    const order = inserted.rows[0];
    // Lost a race with a concurrent request for the same reference.
    if (!order) return (await this.db.query<OrderRow>('SELECT * FROM orders WHERE reference = $1', [input.reference])).rows[0]!;

    try {
      const invoice = await this.qpay.createInvoice({
        invoice_code: this.config.QPAY_INVOICE_CODE,
        sender_invoice_no: order.id,
        invoice_receiver_code: 'terminal',
        invoice_description: input.description,
        amount,
        callback_url: this.callbackUrl(order.id),
      });
      const { rows } = await this.db.query<OrderRow>(
        `UPDATE orders SET qpay_invoice_id = $2, qpay_invoice = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [order.id, invoice.invoice_id, JSON.stringify(invoice)],
      );
      return rows[0]!;
    } catch (err) {
      await this.db.query(`UPDATE orders SET status = 'FAILED', updated_at = now() WHERE id = $1`, [order.id]);
      throw err;
    }
  }

  callbackUrl(orderId: string): string {
    const token = signValue(this.config.APP_SECRET, orderId);
    return `${this.config.PUBLIC_BASE_URL}/webhooks/qpay/${orderId}?token=${token}`;
  }

  /**
   * Asks QPay whether the invoice is paid. Never trusts the callback itself.
   * Safe to call any number of times; the PAID transition happens once.
   */
  async checkPayment(orderId: string): Promise<OrderRow | undefined> {
    const order = await this.get(orderId);
    if (!order || order.status !== 'PENDING' || !order.qpay_invoice_id) return order;

    const res = await this.qpay.checkInvoicePayments(order.qpay_invoice_id);
    await this.db.query('UPDATE orders SET last_checked_at = now() WHERE id = $1', [orderId]);

    const paid = res.rows.filter((r) => r.payment_status === 'PAID');
    const paidAmount = paid.reduce((s, r) => s + Number(r.payment_amount), 0);
    if (paid.length === 0 || paidAmount + 0.005 < order.amount) return order;

    await tx(this.db, async (c) => {
      const updated = await c.query(
        `UPDATE orders SET status = 'PAID', paid_at = now(), paid_amount = $2, qpay_payment_id = $3, updated_at = now()
         WHERE id = $1 AND status = 'PENDING'`,
        [orderId, paidAmount, paid[0]!.payment_id],
      );
      if (updated.rowCount) {
        await enqueue(c, 'ebarimt.issue', { orderId }, { idempotencyKey: `ebarimt.issue:${orderId}`, maxAttempts: 15 });
        this.log.info({ orderId, paidAmount }, 'order paid');
      }
    });
    return this.get(orderId);
  }

  /** Safety net for missed QPay callbacks. */
  async reconcilePending(): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM orders
       WHERE status = 'PENDING' AND qpay_invoice_id IS NOT NULL
         AND created_at > now() - interval '24 hours'
         AND (last_checked_at IS NULL OR last_checked_at < now() - interval '30 seconds')
       ORDER BY created_at LIMIT 50`,
    );
    for (const { id } of rows) {
      await this.checkPayment(id).catch((err) => this.log.warn({ err, orderId: id }, 'reconcile check failed'));
    }
  }

  async cancel(orderId: string): Promise<OrderRow | undefined> {
    const order = await this.checkPayment(orderId);
    if (!order) return undefined;
    if (order.status !== 'PENDING') throw new OrderError(`cannot cancel an order in status ${order.status}`);
    if (order.qpay_invoice_id) await this.qpay.cancelInvoice(order.qpay_invoice_id);
    await this.db.query(`UPDATE orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [orderId]);
    return this.get(orderId);
  }

  /** Refunds the QPay payment, then voids the ebarimt receipt in the background. */
  async refund(orderId: string, note?: string): Promise<OrderRow | undefined> {
    const order = await this.get(orderId);
    if (!order) return undefined;
    if (order.status !== 'PAID' || !order.qpay_payment_id) throw new OrderError(`cannot refund an order in status ${order.status}`);

    await this.qpay.refundPayment(order.qpay_payment_id, note);
    await tx(this.db, async (c) => {
      await c.query(`UPDATE orders SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [orderId]);
      await enqueue(c, 'ebarimt.return', { orderId }, { idempotencyKey: `ebarimt.return:${orderId}` });
    });
    return this.get(orderId);
  }
}
