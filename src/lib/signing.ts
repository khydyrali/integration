import { createHmac, timingSafeEqual } from 'node:crypto';

export function signValue(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 40);
}

export function verifySignedValue(secret: string, value: string, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signValue(secret, value));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
