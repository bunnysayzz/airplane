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
// T8 hardening: all app signing goes through the KeyStorePort.sign() seam
// (signWithDeviceKey / signDeviceEvent below). Call-sites never receive the
// secret key — only this module (custody owner) and the DM key derivation
// (dm.ts, which needs the secret itself to derive X25519 keys, not to sign)
// ever touch it. HONEST LIMIT, not an enclave claim: on the
// expo-secure-store path, KeyStorePort.sign() itself loads the secret from
// the platform keystore into JS memory to run the pure-JS ed25519 sign, so
// the secret still transits app memory briefly inside the store. What the
// seam buys is containment (one place touches it, swappable for a native
// enclave signer later without touching call-sites) plus a session cache
// boundary — not hardware-backed signing. See the T8 note in the report.

import {
  NobleCrypto,
  eventId,
  toHex,
  type CryptoPort,
  type EventKind,
  type SignedEvent,
  type UnsignedEventFields,
} from '@airplane/protocol';
import {
  MemoryKeyStore,
  SecureKeyStore,
  loadOrGenerateKeypair,
  type DeviceKeypair,
  type KeyStorePort,
  type SecureStoreLike,
} from '@airplane/crypto';
import { addBreadcrumb } from '../../src/sentry';

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
  // A (re-)injection resets the fallback latch: the fallback re-establishes
  // itself on the next failed secure-store load, if it still fails.
  fallbackActive = false;
}

/**
 * Memoized default store (T8). The default store MUST be one instance per
 * process: signWithDeviceKey() signs through the same store that loaded the
 * key, and a fresh MemoryKeyStore per call would be empty (no key) in
 * environments without the native module. All instances over the real
 * SecureStore share one backing item, so memoizing changes nothing on
 * device — it only makes the no-native-module path consistent.
 */
let defaultStore: KeyStorePort | null = null;

function defaultKeyStore(): KeyStorePort {
  if (defaultStore) return defaultStore;
  // Lazy require: expo-secure-store has no node-compatible entry, so a
  // top-level import would break Jest. On device (Expo dev build) the
  // native module resolves and we get real Keychain/Keystore persistence.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SecureStore = require('expo-secure-store') as SecureStoreLike & {
      AFTER_FIRST_UNLOCK?: number;
    };
    defaultStore = new SecureKeyStore(SecureStore, {
      storeOptions:
        SecureStore.AFTER_FIRST_UNLOCK !== undefined
          ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }
          : undefined,
    });
  } catch {
    // Jest, Expo Go, or any environment without the native module linked.
    defaultStore = new MemoryKeyStore();
  }
  return defaultStore;
}

/**
 * Session-scoped fallback keystore (T1 publish fix). When the default secure
 * store resolves at require time but throws at CALL time on a real device
 * (native module unlinked/broken — the exact class defaultKeyStore() cannot
 * see), posting must not die: the device falls back to this in-memory store
 * for the session. The identity is EPHEMERAL (dies with the process, unlike
 * the persisted secure-store key), but posting WORKS, and a Sentry breadcrumb
 * records that the fallback fired. One instance per session so the fallback
 * identity stays stable across posts until restart.
 */
let memoryFallback: MemoryKeyStore | null = null;

/** True once the session has fallen back to the in-memory store (T8). */
let fallbackActive = false;

/**
 * True when a secure-store failure means the native module itself is
 * missing or unlinked at call time (the only class the session fallback
 * exists for). Any other failure, including a corrupt stored value,
 * means an existing key may be unreadable: minting an ephemeral key
 * over it would silently swap the device identity, orphaning old posts
 * (no tombstones) and changing receipts. Those errors fail loud so the
 * caller sees the real failure and the next caller retries (the
 * in-flight guard is cleared on failure in getDeviceKeypair); a cached
 * last-known keypair, when one exists, is returned before this path is
 * ever reached, so it survives a transient read failure.
 */
function isMissingModuleError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not available|not linked|unlinked|missing native module|no native module/i.test(message);
}

/**
 * Load-or-generate through the default store, falling back to the in-memory
 * store ONLY when the secure store's native module is missing at call
 * time. An explicitly injected store (tests/dev) never falls back; it
 * must fail loud. A corrupt-value or other read error also fails loud:
 * it is surfaced as a breadcrumb plus the rethrown error, never as a
 * silent swap to an ephemeral identity.
 */
async function loadDefaultKeypair(): Promise<DeviceKeypair> {
  try {
    return await loadOrGenerateKeypair(defaultKeyStore());
  } catch (err) {
    if (!isMissingModuleError(err)) {
      addBreadcrumb('keystore-read-error', {
        reason: err instanceof Error ? err.name : 'unknown',
      });
      throw err;
    }
    memoryFallback ??= new MemoryKeyStore();
    fallbackActive = true;
    addBreadcrumb('keystore-fallback', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return loadOrGenerateKeypair(memoryFallback);
  }
}

/**
 * The store that actually holds the live identity: the injected store when
 * one is set, the session fallback store when the secure store failed, else
 * the memoized default store. Signing and rotation go through this — never
 * through a fresh store instance, which could point at different backing.
 */
function activeKeyStore(): KeyStorePort {
  if (injected) return injected;
  if (fallbackActive && memoryFallback) return memoryFallback;
  return defaultKeyStore();
}

let cached: DeviceKeypair | null = null;

/** Copy both byte arrays: callers must never hold the cached reference. */
function copyKeypair(kp: DeviceKeypair): DeviceKeypair {
  return { publicKey: kp.publicKey.slice(), secretKey: kp.secretKey.slice() };
}

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
 * launch never re-reads the keystore per signature. Every call returns a
 * COPY of the cached pair, never the cached reference: Uint8Array is
 * mutable, so a caller holding the reference could read or corrupt the
 * cached secret bytes for all later signing.
 */
export async function getDeviceKeypair(): Promise<DeviceKeypair> {
  if (cached) return copyKeypair(cached);
  if (inflight) return inflight.then(copyKeypair);
  const promise = injected ? loadOrGenerateKeypair(injected) : loadDefaultKeypair();
  inflight = promise;
  try {
    cached = await promise;
    return copyKeypair(cached);
  } finally {
    // Clear in BOTH paths: on success cached now owns it; on failure the
    // next caller must retry rather than await a settled rejection forever.
    inflight = null;
  }
}

/**
 * The device's current public key, without handing the caller the secret.
 * Callers that only stamp a pubkey (BLE radio bring-up, transport) use this
 * instead of getDeviceKeypair() so the secret never transits their scope.
 * (The keypair is still cached in this module — see the T8 note above.)
 */
export async function getDevicePublicKey(): Promise<Uint8Array> {
  const kp = await getDeviceKeypair();
  return kp.publicKey;
}

/**
 * Sign `msg` through the active keystore's sign() seam. The caller never
 * sees the secret key: only the store implementation loads it (from the
 * platform keystore into JS memory, briefly) to run the ed25519 sign.
 * Ensures a keypair exists first, so first-launch signing generates one
 * exactly like getDeviceKeypair() does.
 */
export async function signWithDeviceKey(msg: Uint8Array): Promise<Uint8Array> {
  await getDeviceKeypair();
  return activeKeyStore().sign(msg);
}

/**
 * Build + sign a full event through the seam: the protocol's eventId over
 * the fields, signed by signWithDeviceKey(). Same wire shape as protocol's
 * synchronous signEvent — id = eventId(fields), sig = ed25519(id) — but
 * async, because the store's sign() is async. This is the ONLY signing
 * path app call-sites (composer, stars, reshares, view receipts) may use;
 * protocol's signEvent stays for tests and pure-protocol code.
 */
export async function signDeviceEvent(
  fields: Omit<UnsignedEventFields, 'pubkey'> & { kind: EventKind },
): Promise<SignedEvent> {
  const pubkey = await getDevicePublicKey();
  const full: UnsignedEventFields = { ...fields, pubkey };
  const id = eventId(full);
  const sig = await signWithDeviceKey(id);
  return { ...full, id, sig };
}

/** Listeners run after a successful rotation (stars/view/DM caches). */
export type IdentityChangeListener = () => void;
const identityChangeListeners = new Set<IdentityChangeListener>();

/**
 * Register a callback for identity rotation. Returns an unsubscribe.
 * Modules that cache identity-derived state (stars' own-pubkey cache,
 * view tracker's per-launch receipt set, the DM service singleton) clear
 * that state here so the new identity takes effect without an app restart.
 */
export function onIdentityChange(listener: IdentityChangeListener): () => void {
  identityChangeListeners.add(listener);
  return () => {
    identityChangeListeners.delete(listener);
  };
}

export interface RotationResult {
  /** Hex of the burned (old) public key. */
  oldPublicKeyHex: string;
  /** Hex of the new public key. */
  newPublicKeyHex: string;
}

/**
 * Burn the current identity and mint a fresh one (T8, Settings → Identity).
 *
 * Sequence: generate the new keypair FIRST, then wipe the old one, then
 * store the new one — so a wipe failure leaves the old identity intact
 * (rotation aborts, nothing burned). If storing the new key fails after
 * the wipe, the cache is cleared and the next load regenerates a fresh key,
 * so the user is never left keyless — just with a different new key than
 * the one this call generated. Old posts, stars, reshares and receipts
 * stay under the OLD pubkey: nothing re-signs them, and a tombstone from
 * the new key cannot delete old posts (authorship is abandoned, not
 * transferred). The DM address is derived from the mesh secret, so it
 * changes too — old DM peers cannot reach the new identity.
 *
 * On a fallback (in-memory) identity the burn only affects this session:
 * the fallback key dies with the process anyway.
 */
export async function rotateDeviceKey(): Promise<RotationResult> {
  const oldKp = await getDeviceKeypair();
  const store = activeKeyStore();
  const next = store.generateKeypair();
  await store.wipeKeypair();
  try {
    await store.storeKeypair(next);
  } catch (err) {
    // Wiped but not re-stored: clear every cache so the next load mints a
    // fresh key rather than serving the burned one, and notify listeners
    // (notably the DM singleton reset) before rethrowing, or the DM
    // service keeps serving the burned identity after a failed burn.
    cached = null;
    inflight = null;
    identityChangeListeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // One listener's failure must not mask the rotation failure.
      }
    });
    throw err;
  }
  cached = next;
  inflight = null;
  identityChangeListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // One listener's failure must not roll back a completed rotation.
    }
  });
  return {
    oldPublicKeyHex: toHex(oldKp.publicKey),
    newPublicKeyHex: toHex(next.publicKey),
  };
}

/**
 * Test seam: drop the cached keypair (and any injected keystore, plus any
 * in-flight load) so the next getDeviceKeypair() load-or-generates fresh -
 * simulating a new device / burned identity. Also drops the memoized
 * default store: in Jest the default is a fresh in-memory store per reset,
 * so keeping the old instance would resurrect the pre-reset key.
 */
export function __resetDeviceKeypairForTests(): void {
  cached = null;
  injected = null;
  inflight = null;
  memoryFallback = null;
  defaultStore = null;
  fallbackActive = false;
}
