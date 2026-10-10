import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySvixSignature } from '../src/email/webhook.js';
import { signValue, verifySignedValue } from '../src/lib/signing.js';

describe('verifySvixSignature', () => {
  const secretBytes = Buffer.from('super-secret-webhook-key');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const body = '{"type":"email.delivered"}';
  const sign = (id: string, ts: string) => createHmac('sha256', secretBytes).update(`${id}.${ts}.${body}`).digest('base64');

  it('accepts a valid signature among several', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = `v1,bogus v1,${sign('msg_1', ts)}`;
    expect(verifySvixSignature(secret, { id: 'msg_1', timestamp: ts, signature }, body)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySvixSignature(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sign('msg_1', ts)}` }, body + ' ')).toBe(false);
  });

  it('rejects stale timestamps', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifySvixSignature(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sign('msg_1', ts)}` }, body)).toBe(false);
  });
});

describe('callback signing', () => {
  it('round-trips and rejects other values', () => {
    const sig = signValue('s'.repeat(32), 'order-1');
    expect(verifySignedValue('s'.repeat(32), 'order-1', sig)).toBe(true);
    expect(verifySignedValue('s'.repeat(32), 'order-2', sig)).toBe(false);
    expect(verifySignedValue('s'.repeat(32), 'order-1', undefined)).toBe(false);
  });
});
