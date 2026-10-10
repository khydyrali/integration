import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/** Verifies a Svix-signed webhook (used by Resend). */
export function verifySvixSignature(secret: string, h: SvixHeaders, rawBody: string, toleranceSec = 300): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest('base64'));

  return h.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
