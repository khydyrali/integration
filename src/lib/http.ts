export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded. */
  body?: unknown;
  timeoutMs?: number;
}

export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  const text = await res.text();
  let data: unknown = text;
  if (text && res.headers.get('content-type')?.includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep raw text
    }
  }
  if (!res.ok) {
    throw new HttpError(res.status, data, `${opts.method ?? 'GET'} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return (text ? data : undefined) as T;
}

/** The request may or may not have reached the remote side. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Worth retrying later: network failures, timeouts, 408/429/5xx. Other 4xx are caller errors. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return true;
}
