import { describe, expect, it } from 'vitest';
import { buildReceipt, orderItemSchema, orderTotal, type MerchantSettings } from '../src/ebarimt/receipt.js';
import { splitTaxes } from '../src/ebarimt/tax.js';

const merchant: MerchantSettings = {
  merchantTin: '37900846788',
  posNo: '10011702',
  branchNo: '001',
  districtCode: '3505',
  vatPayer: true,
  cityTaxRate: 0.02,
};

const item = (o: Record<string, unknown>) => orderItemSchema.parse({ classificationCode: '2349010', ...o });

describe('splitTaxes', () => {
  it('extracts 10% VAT from a tax-inclusive price', () => {
    expect(splitTaxes(11_000, 'VAT_ABLE', 0)).toEqual({ vat: 1000, cityTax: 0 });
  });

  it('extracts VAT and city tax together', () => {
    expect(splitTaxes(11_200, 'VAT_ABLE', 0.02)).toEqual({ vat: 1000, cityTax: 200 });
  });

  it('charges no VAT on exempt goods', () => {
    expect(splitTaxes(10_200, 'VAT_FREE', 0.02)).toEqual({ vat: 0, cityTax: 200 });
  });
});

describe('buildReceipt', () => {
  it('builds a B2C receipt grouped by tax type with consistent totals', () => {
    const items = [
      item({ name: 'Coffee', qty: 2, unitPrice: 5_600, cityTax: true }),
      item({ name: 'Cake', qty: 1, unitPrice: 3_300 }),
      item({ name: 'Book', qty: 1, unitPrice: 20_000, taxType: 'VAT_FREE', taxProductCode: '305' }),
    ];
    const r = buildReceipt({ items, paymentCode: 'PAYMENT_CARD' }, merchant);

    expect(r.type).toBe('B2C_RECEIPT');
    expect(r.totalAmount).toBe(orderTotal(items));
    expect(r.totalAmount).toBe(34_500);
    expect(r.receipts.map((s) => s.taxType)).toEqual(['VAT_ABLE', 'VAT_FREE']);

    const vatable = r.receipts[0]!;
    expect(vatable.totalAmount).toBe(14_500);
    expect(vatable.totalVAT).toBe(1_000 + 300);
    expect(vatable.totalCityTax).toBe(200);
    expect(r.totalVAT).toBe(1_300);
    expect(r.payments).toEqual([{ code: 'PAYMENT_CARD', status: 'PAID', paidAmount: 34_500 }]);
  });

  it('issues B2B when a customer TIN is present and drops consumerNo', () => {
    const r = buildReceipt(
      { items: [item({ name: 'Service', qty: 1, unitPrice: 1_100 })], customerTin: '12345678901', consumerNo: '99', paymentCode: 'CASH' },
      merchant,
    );
    expect(r.type).toBe('B2B_RECEIPT');
    expect(r.customerTin).toBe('12345678901');
    expect(r.consumerNo).toBeUndefined();
  });

  it('forces NO_VAT for merchants that are not VAT payers', () => {
    const r = buildReceipt({ items: [item({ name: 'X', qty: 1, unitPrice: 1_100 })], paymentCode: 'CASH' }, { ...merchant, vatPayer: false });
    expect(r.receipts[0]!.taxType).toBe('NO_VAT');
    expect(r.totalVAT).toBe(0);
  });

  it('requires taxProductCode for exempt items', () => {
    expect(() => item({ name: 'Book', qty: 1, unitPrice: 1, taxType: 'VAT_ZERO' })).toThrow(/taxProductCode/);
  });
});
