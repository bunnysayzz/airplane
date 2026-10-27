// SPDX-License-Identifier: Apache-2.0
import { NobleCrypto, signEvent, verifyEvent } from './ed25519';
import { makePost } from '../test-helpers';

describe('ed25519 signing', () => {
  test('sign then verify round-trips', () => {
    const crypto = new NobleCrypto();
    const event = makePost('sign me');
    expect(verifyEvent(crypto, event)).toBe(true);
  });

  test('signEvent produces a 32-byte id and 64-byte sig', () => {
    const crypto = new NobleCrypto();
    const { publicKey, secretKey } = crypto.generateKeypair();
    const event = signEvent(crypto, secretKey, {
      pubkey: publicKey,
      created_at: 1_700_000_000,
      kind: 1,
      geohash: 'ezs42',
      tags: [],
      content: 'sizes',
    });
    expect(event.id).toHaveLength(32);
    expect(event.sig).toHaveLength(64);
  });

  test('signature from the wrong key fails verification', () => {
    const crypto = new NobleCrypto();
    const alice = crypto.generateKeypair();
    const bob = crypto.generateKeypair();
    // Signed with Bob's secret key but stamped with Alice's pubkey.
    const forged = signEvent(crypto, bob.secretKey, {
      pubkey: alice.publicKey,
      created_at: 1_700_000_000,
      kind: 1,
      geohash: 'ezs42',
      tags: [],
      content: 'forged',
    });
    expect(verifyEvent(crypto, forged)).toBe(false);
  });

  test('raw sign/verify and cross-key failure', () => {
    const crypto = new NobleCrypto();
    const a = crypto.generateKeypair();
    const b = crypto.generateKeypair();
    const msg = new TextEncoder().encode('raw message');
    const sig = crypto.sign(a.secretKey, msg);
    expect(sig).toHaveLength(64);
    expect(crypto.verify(sig, msg, a.publicKey)).toBe(true);
    expect(crypto.verify(sig, msg, b.publicKey)).toBe(false);
    const tampered = new Uint8Array(sig);
    tampered[10] ^= 0x01;
    expect(crypto.verify(tampered, msg, a.publicKey)).toBe(false);
  });

  test('verifyEvent returns false on garbage, never throws', () => {
    const crypto = new NobleCrypto();
    const event = makePost('garbage test');
    expect(verifyEvent(crypto, { ...event, sig: new Uint8Array(64) })).toBe(false);
    expect(verifyEvent(crypto, { ...event, id: new Uint8Array(32) })).toBe(false);
  });
});
