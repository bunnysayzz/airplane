// SPDX-License-Identifier: Apache-2.0
// Shared fixtures for protocol tests (not a test file itself).

import { createPost } from './payloads/posts';
import { NobleCrypto, signEvent } from './sign/ed25519';
import { encodeEvent } from './codec/cbor';
import type { SignedEvent } from './events/types';

export interface Keypair {
  crypto: NobleCrypto;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function makeKeypair(): Keypair {
  const crypto = new NobleCrypto();
  const { publicKey, secretKey } = crypto.generateKeypair();
  return { crypto, publicKey, secretKey };
}

export function makePost(content = 'hello mesh', createdAt = 1_700_000_000): SignedEvent {
  const { crypto, publicKey, secretKey } = makeKeypair();
  return createPost({
    crypto,
    secretKey,
    pubkey: publicKey,
    geohash5: 'ezs42',
    content,
    createdAt,
  });
}

/**
 * Build a valid signed event whose CBOR encoding is exactly `targetBytes`
 * long (used for fragmentation boundary tests). Pads via a tag string.
 */
export function makeSizedEvent(targetBytes: number): Uint8Array {
  const { crypto, publicKey, secretKey } = makeKeypair();
  let padLen = targetBytes;
  for (let i = 0; i < 25; i++) {
    const event = signEvent(crypto, secretKey, {
      pubkey: publicKey,
      created_at: 1_700_000_000,
      kind: 1,
      geohash: 'ezs42',
      tags: [['pad', 'y'.repeat(Math.max(0, padLen))]],
      content: 'hi',
    });
    const bytes = encodeEvent(event);
    const diff = bytes.length - targetBytes;
    if (diff === 0) return bytes;
    padLen -= diff; // ASCII pad: 1 char = 1 byte, converges fast
  }
  throw new Error(`makeSizedEvent: did not converge on ${targetBytes} bytes`);
}
