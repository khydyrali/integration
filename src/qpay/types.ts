export interface QPayTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  /** QPay returns an absolute unix timestamp (seconds) here. */
  expires_in: number;
  refresh_expires_in: number;
}

export interface QPayInvoiceRequest {
  invoice_code: string;
  sender_invoice_no: string;
  invoice_receiver_code: string;
  invoice_description: string;
  amount: number;
  callback_url: string;
  sender_branch_code?: string;
  invoice_due_date?: string;
  allow_partial?: boolean;
  minimum_amount?: number;
  allow_exceed?: boolean;
  maximum_amount?: number;
  note?: string;
}

export interface QPayDeeplink {
  name: string;
  description: string;
  logo: string;
  link: string;
}

export interface QPayInvoiceResponse {
  invoice_id: string;
  qr_text: string;
  /** Base64-encoded PNG. */
  qr_image: string;
  qPay_shortUrl: string;
  urls: QPayDeeplink[];
}

export type QPayPaymentStatus = 'NEW' | 'FAILED' | 'PAID' | 'PARTIAL' | 'REFUNDED';

export interface QPayPayment {
  payment_id: string;
  payment_status: QPayPaymentStatus;
  payment_amount: string | number;
  payment_currency: string;
  payment_date: string;
  payment_wallet: string;
  transaction_type: string;
  trx_fee?: string | number;
}

export interface QPayPaymentCheckResponse {
  count: number;
  paid_amount?: number;
  rows: QPayPayment[];
}
