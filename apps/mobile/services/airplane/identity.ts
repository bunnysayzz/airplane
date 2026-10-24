// SPDX-License-Identifier: Apache-2.0
// Device identity: the STABLE per-device Ed25519 mesh keypair.
//
// Load-or-generate behind the `KeyStorePort` (blueprint-v2 PLAN_CHANGELOG.md
// §1 item 5, SYSTEM_DESIGN.md §4.7 CRYPTO-1). On a real Expo dev build the
// key lives in the platform keystore (iOS Keychain / Android Keystore) via
// expo-secure-store; in Jest/node it falls back to an in-memory store.
// Tests inject their own port with `setKeyStore`.
//
// PRIVACY TRADE-OFF - stable key = linkable pseudonym:
// A stable per-device keypair means every post, receipt, and tombstone from
// this device carries the same pubkey, so anyone holding two events can prove
// they came from one device. This is the price of enforceable tombstones and
// honest view counts - the v2 blueprint accepts it: authorship continuity
// REQUIRES continuity of identity (an ephemeral key makes
// `tombstone.pubkey == post.pubkey` unenforceable and receipt dedup
// meaningless across restarts).
// Rotation (settings -> burn key -> new pubkey) abandons old authorship: a
// tombstone from the new key cannot delete posts signed by the old one.
// The RELAY identity (secp256k1/Nostr envelope, v2 §4.7) is a SEPARATE,
// independently generated keypair with no published binding - unlinkable to
// this mesh key by default. Not built here.
//
// P3 hardening: signing still happens with the secret key in app memory via
// protocol's signEvent. The KeyStorePort.sign() seam exists so a later pass
// can move all signing behind the store and keep key material out of the
// app process entirely.

import { NobleCrypto, type CryptoPort } from '@airplane/protocol';
import {
  MemoryKeyStore,
  SecureKeyStore,
  loadOrGenerateKeypair,
  type DeviceKeypair,
  type KeyStorePort,
  type SecureStoreLike,
} from '@airplane/crypto';

export type { DeviceKeypair };

/** Shared crypto backend (pure JS ops; key *custody* lives in KeyStorePort). */
export const crypto: CryptoPort = new NobleCrypto();

/** Test/dev seam: an explicitly injected keystore wins over the default. */
let injected: KeyStorePort | null = null;

/** Inject a KeyStorePort (tests, dev). Pass null to restore the default. */
export function setKeyStore(ks: KeyStorePort | null): void {
  injected = ks;
  cached = null;
  inflight = null;
}

function defaultKeyStore(): KeyStorePort {
  // Lazy require: expo-secure-store has no node-compatible entry, so a
  // top-level import would break Jest. On device (Expo dev build) the
  // native module resolves and we get real Keychain/Keystore persistence.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SecureStore = require('expo-secure-store') as SecureStoreLike & {
      AFTER_FIRST_UNLOCK?: number;
    };
    return new SecureKeyStore(SecureStore, {
      storeOptions:
        SecureStore.AFTER_FIRST_UNLOCK !== undefined
          ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }
          : undefined,
    });
  } catch {
    // Jest, Expo Go, or any environment without the native module linked.
    return new MemoryKeyStore();
  }
}

let cached: DeviceKeypair | null = null;

/**
 * In-flight load-or-generate promise. DATA-LOSS-CLASS race fix: two
 * concurrent getDeviceKeypair() calls would both see `cached === null` and
 * both run loadOrGenerateKeypair, minting TWO keypairs while the keystore
 * persists only the last write - the two callers then diverge onto different
 * identities (tombstones/receipts signed by one stop matching the other).
 * The first caller stores its promise here; concurrent callers await the
 * SAME promise, so the keypair is minted exactly once per cold start.
 * (JS is single-threaded, but awaits yield - the check-then-act gap is real.)
 */
let inflight: Promise<DeviceKeypair> | null = null;

/**
 * The stable device keypair. Generated once on first launch and persisted
 * in the keystore; identical across restarts. Cached in module scope so a
 * launch never re-reads the keystore per signature.
 */
export async function getDeviceKeypair(): Promise<DeviceKeypair> {
  if (cached) return cached;
  if (inflight) return inflight;
  const promise = loadOrGenerateKeypair(injected ?? defaultKeyStore());
  inflight = promise;
  try {
    cached = await promise;
    return cached;
  } finally {
    // Clear in BOTH paths: on success cached now owns it; on failure the
    // next caller must retry rather than await a settled rejection forever.
    inflight = null;
  }
}

/**
 * Test seam: drop the cached keypair (and any injected keystore, plus any
 * in-flight load) so the next getDeviceKeypair() load-or-generates fresh -
 * simulating a new device / burned identity.
 */
export function __resetDeviceKeypairForTests(): void {
  cached = null;
  injected = null;
  inflight = null;
}
