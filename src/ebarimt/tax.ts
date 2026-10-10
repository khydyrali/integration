import type { TaxType } from './types.js';

export const VAT_RATE = 0.1;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Mongolian retail prices are tax-inclusive. Extract VAT and city tax (НХАТ) from a gross amount:
 *   gross = net * (1 + vatRate + cityTaxRate)
 */
export function splitTaxes(gross: number, taxType: TaxType, cityTaxRate: number): { vat: number; cityTax: number } {
  const vatRate = taxType === 'VAT_ABLE' ? VAT_RATE : 0;
  const net = gross / (1 + vatRate + cityTaxRate);
  return { vat: round2(net * vatRate), cityTax: round2(net * cityTaxRate) };
}
