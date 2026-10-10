import { request } from '../lib/http.js';
import type { PosReceiptRequest, PosReceiptResponse } from './types.js';

export class EbarimtError extends Error {
  constructor(message: string, readonly response?: unknown) {
    super(message);
    this.name = 'EbarimtError';
  }
}

/** Client for the locally installed PosAPI 3.0 service. */
export class PosApiClient {
  constructor(private readonly baseUrl: string) {}

  async createReceipt(body: PosReceiptRequest): Promise<PosReceiptResponse> {
    const res = await request<PosReceiptResponse>(`${this.baseUrl}/rest/receipt`, { method: 'POST', body, timeoutMs: 30_000 });
    if (res?.status !== 'SUCCESS') {
      throw new EbarimtError(`PosAPI rejected receipt: ${res?.message ?? JSON.stringify(res)}`, res);
    }
    return res;
  }

  /** Void a previously issued receipt (e.g. after a refund). */
  async returnReceipt(id: string, date: string): Promise<void> {
    await request(`${this.baseUrl}/rest/receipt`, { method: 'DELETE', body: { id, date }, timeoutMs: 30_000 });
  }

  /** Operator/merchant registration, remaining lottery count, last sync time, etc. */
  info(): Promise<unknown> {
    return request(`${this.baseUrl}/rest/info`);
  }

  /** Push unsent receipts to the central system now instead of waiting for the scheduled sync. */
  sendData(): Promise<unknown> {
    return request(`${this.baseUrl}/rest/sendData`, { timeoutMs: 60_000 });
  }
}

interface PublicApiEnvelope<T> {
  status: number;
  msg?: string;
  data: T;
}

export interface TaxpayerInfo {
  name: string;
  vatPayer: boolean;
  cityPayer: boolean;
  [key: string]: unknown;
}

/** Public lookups on api.ebarimt.mn (no credentials needed). */
export class EbarimtPublicApi {
  constructor(private readonly baseUrl: string) {}

  async tinByRegNo(regNo: string): Promise<string> {
    const res = await request<PublicApiEnvelope<string | number>>(
      `${this.baseUrl}/api/info/check/getTinInfo?regNo=${encodeURIComponent(regNo)}`,
    );
    if (res.status !== 200 || !res.data) throw new EbarimtError(`No TIN found for registration number ${regNo}`, res);
    return String(res.data);
  }

  async taxpayerInfo(tin: string): Promise<TaxpayerInfo> {
    const res = await request<PublicApiEnvelope<TaxpayerInfo>>(
      `${this.baseUrl}/api/info/check/getInfo?tin=${encodeURIComponent(tin)}`,
    );
    if (res.status !== 200 || !res.data) throw new EbarimtError(`No taxpayer found for TIN ${tin}`, res);
    return res.data;
  }
}
