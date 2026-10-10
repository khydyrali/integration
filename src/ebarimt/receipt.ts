import { z } from 'zod';
import { round2, splitTaxes } from './tax.js';
import { TAX_TYPES, type PaymentCode, type PosItem, type PosReceiptRequest, type PosSubReceipt, type TaxType } from './types.js';

export const orderItemSchema = z
  .object({
    name: z.string().min(1).max(255),
    qty: z.number().positive(),
    /** Tax-inclusive unit price in MNT. */
    unitPrice: z.number().nonnegative(),
    measureUnit: z.string().min(1).default('ш'),
    /** БҮНА product classification code. */
    classificationCode: z.string().min(1),
    barCode: z.string().optional(),
    barCodeType: z.enum(['UNDEFINED', 'GS1', 'ISBN']).default('UNDEFINED'),
    taxType: z.enum(TAX_TYPES).default('VAT_ABLE'),
    /** Required for VAT_FREE / VAT_ZERO items (exemption product code). */
    taxProductCode: z.string().optional(),
    /** Whether НХАТ applies to this item. */
    cityTax: z.boolean().default(false),
  })
  .refine((i) => (i.taxType !== 'VAT_FREE' && i.taxType !== 'VAT_ZERO') || !!i.taxProductCode, {
    message: 'taxProductCode is required for VAT_FREE and VAT_ZERO items',
    path: ['taxProductCode'],
  });

export type OrderItem = z.infer<typeof orderItemSchema>;

export interface MerchantSettings {
  merchantTin: string;
  posNo: string;
  branchNo: string;
  districtCode: string;
  vatPayer: boolean;
  cityTaxRate: number;
}

export interface ReceiptInput {
  items: OrderItem[];
  customerTin?: string | null;
  consumerNo?: string | null;
  paymentCode: PaymentCode;
}

export function orderTotal(items: OrderItem[]): number {
  return round2(items.reduce((sum, i) => sum + round2(i.qty * i.unitPrice), 0));
}

export function buildReceipt(input: ReceiptInput, m: MerchantSettings): PosReceiptRequest {
  const groups = new Map<TaxType, PosItem[]>();

  for (const item of input.items) {
    // A merchant that is not VAT-registered can only issue NO_VAT receipts.
    const taxType: TaxType = m.vatPayer ? item.taxType : 'NO_VAT';
    const totalAmount = round2(item.qty * item.unitPrice);
    const { vat, cityTax } = splitTaxes(totalAmount, taxType, item.cityTax ? m.cityTaxRate : 0);
    const posItem: PosItem = {
      name: item.name,
      barCode: item.barCode,
      barCodeType: item.barCodeType,
      classificationCode: item.classificationCode,
      taxProductCode: item.taxProductCode,
      measureUnit: item.measureUnit,
      qty: item.qty,
      unitPrice: item.unitPrice,
      totalVAT: vat,
      totalCityTax: cityTax,
      totalAmount,
    };
    groups.set(taxType, [...(groups.get(taxType) ?? []), posItem]);
  }

  const receipts: PosSubReceipt[] = [...groups].map(([taxType, items]) => ({
    taxType,
    merchantTin: m.merchantTin,
    customerTin: input.customerTin ?? undefined,
    totalAmount: sum(items, 'totalAmount'),
    totalVAT: sum(items, 'totalVAT'),
    totalCityTax: sum(items, 'totalCityTax'),
    items,
  }));

  const totalAmount = sum(receipts, 'totalAmount');
  return {
    type: input.customerTin ? 'B2B_RECEIPT' : 'B2C_RECEIPT',
    merchantTin: m.merchantTin,
    posNo: m.posNo,
    branchNo: m.branchNo,
    districtCode: m.districtCode,
    customerTin: input.customerTin ?? undefined,
    consumerNo: input.customerTin ? undefined : (input.consumerNo ?? undefined),
    totalAmount,
    totalVAT: sum(receipts, 'totalVAT'),
    totalCityTax: sum(receipts, 'totalCityTax'),
    receipts,
    payments: [{ code: input.paymentCode, status: 'PAID', paidAmount: totalAmount }],
  };
}

function sum<K extends string>(rows: Record<K, number>[], key: K): number {
  return round2(rows.reduce((acc, r) => acc + r[key], 0));
}
