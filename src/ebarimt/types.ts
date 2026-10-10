export const TAX_TYPES = ['VAT_ABLE', 'VAT_FREE', 'VAT_ZERO', 'NO_VAT'] as const;
export type TaxType = (typeof TAX_TYPES)[number];

export type ReceiptType = 'B2C_RECEIPT' | 'B2B_RECEIPT' | 'B2C_INVOICE' | 'B2B_INVOICE';
export type BarCodeType = 'UNDEFINED' | 'GS1' | 'ISBN';
export type PaymentCode = 'CASH' | 'PAYMENT_CARD';

export interface PosItem {
  name: string;
  barCode?: string;
  barCodeType: BarCodeType;
  classificationCode: string;
  taxProductCode?: string;
  measureUnit: string;
  qty: number;
  unitPrice: number;
  totalVAT: number;
  totalCityTax: number;
  totalAmount: number;
}

export interface PosSubReceipt {
  totalAmount: number;
  taxType: TaxType;
  merchantTin: string;
  customerTin?: string;
  totalVAT: number;
  totalCityTax: number;
  bankAccountNo?: string;
  iBan?: string;
  items: PosItem[];
}

export interface PosPayment {
  code: PaymentCode;
  exchangeCode?: string;
  status: 'PAID';
  paidAmount: number;
}

/** PosAPI 3.0 POST /rest/receipt body. */
export interface PosReceiptRequest {
  totalAmount: number;
  totalVAT: number;
  totalCityTax: number;
  districtCode: string;
  merchantTin: string;
  posNo: string;
  branchNo: string;
  customerTin?: string;
  consumerNo?: string;
  type: ReceiptType;
  billIdSuffix?: string;
  receipts: PosSubReceipt[];
  payments: PosPayment[];
}

export interface PosReceiptResponse {
  id: string;
  posId?: number;
  status: 'SUCCESS' | 'ERROR' | 'PAYMENT';
  message?: string;
  qrData?: string;
  lottery?: string;
  /** "yyyy-MM-dd HH:mm:ss"; needed again to return (void) the receipt. */
  date: string;
  easy?: boolean;
  receipts?: { id: string; bankAccountId?: number }[];
}
