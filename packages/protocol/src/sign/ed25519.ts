// SPDX-License-Identifier: Apache-2.0
// ed25519 signing via @noble/curves. The CryptoPort keeps all crypto behind an
// interface so native layers can swap in platform keystores later.

import { ed25519 } from '@noble/curves/ed25519.js';

import { eventId } from '../codec/cbor';
import { bytesEqual } from '../hex';
import type { SignedEvent, UnsignedEventFields } from '../events/types';

/** Key material + sign/verify operations. Swappable for platform keystores. */
export interface CryptoPort {
  generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array;
  verify(sig: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean;
}

/** CryptoPort backed by @noble/curves ed25519 (pure JS, no native deps). */
export class NobleCrypto implements CryptoPort {
  generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const secretKey = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secretKey);
    return { publicKey, secretKey };
  }

  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
    return ed25519.sign(msg, secretKey);
  }

  verify(sig: Uint8Array, msg: Uint8Array, pubkey: Uint8Array): boolean {
    try {
      return ed25519.verify(sig, msg, pubkey);
    } catch {
      return false;
    }
  }
}

/**
 * Sign the canonical pre-image of the unsigned fields and assemble the
 * SignedEvent (id = sha256(preimage), sig = ed25519(id)).
 */
export function signEvent(
  crypto: CryptoPort,
  secretKey: Uint8Array,
  fields: UnsignedEventFields,
): SignedEvent {
  const id = eventId(fields);
  const sig = crypto.sign(secretKey, id);
  return { ...fields, id, sig };
}

/**
 * Verify an event: recompute the id from the fields and check it matches,
 * then verify the ed25519 signature over the id. Returns false (never throws)
 * on any mismatch.
 */
export function verifyEvent(crypto: CryptoPort, event: SignedEvent): boolean {
  try {
    const recomputed = eventId(event);
    if (!bytesEqual(recomputed, event.id)) return false;
    return crypto.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}
