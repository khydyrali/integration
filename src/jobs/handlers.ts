import type { Config } from '../config.js';
import { tx, type Db } from '../db.js';
import type { PosApiClient } from '../ebarimt/client.js';
import { buildReceipt } from '../ebarimt/receipt.js';
import type { EmailService } from '../email/service.js';
import { renderReceiptEmail } from '../email/templates.js';
import type { OrderService } from '../orders/service.js';
import { enqueue, PermanentError } from './queue.js';
import type { JobHandler } from './worker.js';

interface Deps {
  db: Db;
  config: Config;
  orders: OrderService;
  posApi: PosApiClient;
  email: EmailService;
}

export function createJobHandlers({ db, config, orders, posApi, email }: Deps): Record<string, JobHandler> {
  return {
    'ebarimt.issue': {
      async run({ orderId }: { orderId: string }) {
        const order = await orders.get(orderId);
        if (!order) throw new PermanentError(`order ${orderId} not found`);
        // Already issued, or refunded before we got to it: nothing to do.
        if (order.ebarimt_id || order.status !== 'PAID') return;

        const receipt = buildReceipt(
          {
            items: order.items,
            customerTin: order.customer_tin,
            consumerNo: order.consumer_no,
            // PosAPI 3.0 only distinguishes cash from non-cash; QPay is non-cash.
            paymentCode: 'PAYMENT_CARD',
          },
          {
            merchantTin: config.EBARIMT_MERCHANT_TIN,
            posNo: config.EBARIMT_POS_NO,
            branchNo: config.EBARIMT_BRANCH_NO,
            districtCode: config.EBARIMT_DISTRICT_CODE,
            vatPayer: config.EBARIMT_VAT_PAYER,
            cityTaxRate: config.EBARIMT_CITY_TAX_RATE,
          },
        );
        const res = await posApi.createReceipt(receipt);
        const mail = order.customer_email
          ? await renderReceiptEmail({
              orderId: order.id,
              description: order.description,
              amount: order.amount,
              items: order.items,
              ebarimtId: res.id,
              lottery: res.lottery,
              qrData: res.qrData,
              date: res.date,
            })
          : undefined;

        await tx(db, async (c) => {
          const { rows } = await c.query<{ status: string }>(
            `UPDATE orders SET ebarimt_id = $2, ebarimt_lottery = $3, ebarimt_qr_data = $4, ebarimt_date = $5,
               ebarimt_response = $6, updated_at = now() WHERE id = $1 RETURNING status`,
            [orderId, res.id, res.lottery ?? null, res.qrData ?? null, res.date, JSON.stringify(res)],
          );
          // A refund raced with issuance; void the receipt we just created.
          if (rows[0]?.status === 'REFUNDED') {
            await enqueue(c, 'ebarimt.return', { orderId }, { idempotencyKey: `ebarimt.return:${orderId}:late` });
          }
          if (mail && order.customer_email) {
            await email.queue({ ...mail, to: order.customer_email, idempotencyKey: `receipt:${orderId}` }, c);
          }
        });
      },
    },

    'ebarimt.return': {
      async run({ orderId }: { orderId: string }) {
        const order = await orders.get(orderId);
        if (!order) throw new PermanentError(`order ${orderId} not found`);
        if (!order.ebarimt_id || !order.ebarimt_date || order.ebarimt_returned_at) return;
        await posApi.returnReceipt(order.ebarimt_id, order.ebarimt_date);
        await db.query('UPDATE orders SET ebarimt_returned_at = now(), updated_at = now() WHERE id = $1', [orderId]);
      },
    },

    'email.send': {
      run: ({ emailId }: { emailId: string }) => email.deliver(emailId),
      onDead: ({ emailId }: { emailId: string }, error) => email.markFailed(emailId, error),
    },
  };
}
