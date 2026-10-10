import { HttpError, request } from '../lib/http.js';
import type {
  QPayInvoiceRequest,
  QPayInvoiceResponse,
  QPayPayment,
  QPayPaymentCheckResponse,
  QPayTokenResponse,
} from './types.js';

export interface QPayClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

interface TokenState {
  access: string;
  accessExpiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}

const EXPIRY_LEEWAY_MS = 60_000;

/** Accepts either an absolute unix timestamp (what QPay sends) or a duration in seconds. */
function toExpiryMs(value: number): number {
  const ms = value > 1_000_000_000 ? value * 1000 : Date.now() + value * 1000;
  return ms - EXPIRY_LEEWAY_MS;
}

/** QPay merchant API v2. */
export class QPayClient {
  private token?: TokenState;
  private inflight?: Promise<string>;

  constructor(private readonly opts: QPayClientOptions) {}

  createInvoice(body: QPayInvoiceRequest): Promise<QPayInvoiceResponse> {
    return this.call('POST', '/v2/invoice', body);
  }

  getInvoice(invoiceId: string): Promise<unknown> {
    return this.call('GET', `/v2/invoice/${encodeURIComponent(invoiceId)}`);
  }

  cancelInvoice(invoiceId: string): Promise<unknown> {
    return this.call('DELETE', `/v2/invoice/${encodeURIComponent(invoiceId)}`);
  }

  checkInvoicePayments(invoiceId: string, page = 1, limit = 100): Promise<QPayPaymentCheckResponse> {
    return this.call('POST', '/v2/payment/check', {
      object_type: 'INVOICE',
      object_id: invoiceId,
      offset: { page_number: page, page_limit: limit },
    });
  }

  getPayment(paymentId: string): Promise<QPayPayment> {
    return this.call('GET', `/v2/payment/${encodeURIComponent(paymentId)}`);
  }

  /** Card payments only; QR payments must be refunded. */
  cancelPayment(paymentId: string, note?: string): Promise<unknown> {
    return this.call('DELETE', `/v2/payment/cancel/${encodeURIComponent(paymentId)}`, { note });
  }

  refundPayment(paymentId: string, note?: string): Promise<unknown> {
    return this.call('DELETE', `/v2/payment/refund/${encodeURIComponent(paymentId)}`, { note });
  }

  private async call<T>(method: string, path: string, body?: unknown, retryOnAuth = true): Promise<T> {
    const access = await this.accessToken();
    try {
      return await request<T>(this.opts.baseUrl + path, {
        method,
        body,
        headers: { authorization: `Bearer ${access}` },
        timeoutMs: 20_000,
      });
    } catch (err) {
      if (retryOnAuth && err instanceof HttpError && err.status === 401) {
        this.token = undefined;
        return this.call(method, path, body, false);
      }
      throw err;
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.accessExpiresAt) return this.token.access;
    // Concurrent callers share one token request.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    if (this.token && Date.now() < this.token.refreshExpiresAt) {
      try {
        return this.store(
          await request<QPayTokenResponse>(`${this.opts.baseUrl}/v2/auth/refresh`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.token.refresh}` },
          }),
        );
      } catch {
        // fall back to a fresh login
      }
    }
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    return this.store(
      await request<QPayTokenResponse>(`${this.opts.baseUrl}/v2/auth/token`, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}` },
      }),
    );
  }

  private store(t: QPayTokenResponse): string {
    this.token = {
      access: t.access_token,
      accessExpiresAt: toExpiryMs(t.expires_in),
      refresh: t.refresh_token,
      refreshExpiresAt: toExpiryMs(t.refresh_expires_in),
    };
    return t.access_token;
  }
}
