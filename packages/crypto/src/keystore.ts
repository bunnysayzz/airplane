// SPDX-License-Identifier: Apache-2.0
// Key custody for the mesh identity (CRYPTO-1, blueprint-v2 §4.7).
//
// The KeyStorePort is the ONLY seam that ever touches private key material.
// Pure crypto *operations* (Ed25519 sign/verify) stay in @airplane/protocol;
// this package owns generation, secure persistence, and access. Direction:
// apps/mobile wires crypto -> protocol; protocol never imports crypto.
//
// SCOPE NOTE: v2's full KeyStorePort also covers the RELAY identity
// (secp256k1 Schnorr for the Nostr envelope). The relay key is a separate,
// independently generated, UNLINKABLE keypair - deliberately OUT OF SCOPE
// here (see identity.ts trade-off comment). Rotation and wipe landed in
// T8: KeyStorePort.wipeKeypair() + identity.ts rotateDeviceKey().

import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * Ed25519 keypair bytes. Both fields are exactly 32 bytes
 * (ed25519 secret key in expanded form is 32 B in @noble/curves).
 */
export interface DeviceKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Key custody port (mesh identity only - see scope note above).
 *
 * Implementations must be safe to call from any async context; callers do
 * not serialize access.
 */
export interface KeyStorePort {
  /** Generate a fresh Ed25519 keypair. Does NOT persist it. */
  generateKeypair(): DeviceKeypair;

  /** Persist a keypair in the secure backing store. */
  storeKeypair(kp: DeviceKeypair): Promise<void>;

  /** Load the persisted keypair, or null when none exists yet. */
  loadKeypair(): Promise<DeviceKeypair | null>;

  /**
   * Ed25519-sign `msg` with the persisted key. Returns 64 bytes.
   * Throws when no keypair is stored. The key never leaves the store -
   * prefer this over loadKeypair()+sign when the caller only needs a
   * signature (P3: move all app signing behind this so key material never
   * enters app memory).
   */
  sign(msg: Uint8Array): Promise<Uint8Array>;

  /** The persisted public key, or null when none exists yet. */
  getPublicKey(): Promise<Uint8Array | null>;

  /**
   * Permanently remove the persisted keypair (T8 key rotation: burn the
   * old identity). After this, loadKeypair() returns null and sign()
   * throws until a new keypair is stored. Implementations must remove
   * the key from the backing store, not just drop an in-memory copy.
   */
  wipeKeypair(): Promise<void>;
}

/** Load the stored keypair, or generate + store one on first launch. */
export async function loadOrGenerateKeypair(ks: KeyStorePort): Promise<DeviceKeypair> {
  const existing = await ks.loadKeypair();
  if (existing) return existing;
  const kp = ks.generateKeypair();
  await ks.storeKeypair(kp);
  return kp;
}

function checkKeypair(kp: DeviceKeypair, what: string): void {
  if (!(kp.publicKey instanceof Uint8Array) || kp.publicKey.length !== 32) {
    throw new Error(`${what}: publicKey must be 32 bytes`);
  }
  if (!(kp.secretKey instanceof Uint8Array) || kp.secretKey.length !== 32) {
    throw new Error(`${what}: secretKey must be 32 bytes`);
  }
}

/**
 * In-memory KeyStorePort. For tests and dev only - the key lives in the JS
 * heap and dies with the process.
 *
 * `backing` is the shared persistence: two instances constructed over the
 * same Map behave like one keystore surviving an app restart - the "restart"
 * test seam (re-instantiate the keystore; the loaded key must be identical).
 */
export class MemoryKeyStore implements KeyStorePort {
  private static readonly ITEM = 'mesh-keypair';
  private readonly backing: Map<string, Uint8Array>;

  constructor(backing?: Map<string, Uint8Array>) {
    this.backing = backing ?? new Map<string, Uint8Array>();
  }

  generateKeypair(): DeviceKeypair {
    const secretKey = ed25519.utils.randomSecretKey();
    return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
  }

  async storeKeypair(kp: DeviceKeypair): Promise<void> {
    checkKeypair(kp, 'MemoryKeyStore.storeKeypair');
    this.backing.set(MemoryKeyStore.ITEM, kp.secretKey.slice());
  }

  async loadKeypair(): Promise<DeviceKeypair | null> {
    const stored = this.backing.get(MemoryKeyStore.ITEM);
    if (!stored) return null;
    const secretKey = stored.slice();
    return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
  }

  async sign(msg: Uint8Array): Promise<Uint8Array> {
    const kp = await this.loadKeypair();
    if (!kp) throw new Error('MemoryKeyStore.sign: no keypair stored');
    return ed25519.sign(msg, kp.secretKey);
  }

  async getPublicKey(): Promise<Uint8Array | null> {
    const kp = await this.loadKeypair();
    return kp ? kp.publicKey : null;
  }

  async wipeKeypair(): Promise<void> {
    this.backing.delete(MemoryKeyStore.ITEM);
  }
}

/** Minimal surface of expo-secure-store that this package needs. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreItemOptions): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Options forwarded to setItemAsync (e.g. expo-secure-store keychainAccessible). */
export interface SecureStoreItemOptions {
  /** e.g. `SecureStore.AFTER_FIRST_UNLOCK` - background relay signing needs the key available without the device being unlocked (blueprint §4.7 trade-off). */
  keychainAccessible?: number;
  [option: string]: unknown;
}

export interface SecureKeyStoreOpts {
  /** SecureStore item key. Default 'airplane.mesh.identity.v1'. */
  itemKey?: string;
  /** Passed through to setItemAsync. */
  storeOptions?: SecureStoreItemOptions;
}

const HEX_DIGITS = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_DIGITS[bytes[i] >> 4] + HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error('SecureKeyStore: stored key is not 32 bytes hex');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const hi = HEX_DIGITS.indexOf(hex[2 * i].toLowerCase());
    const lo = HEX_DIGITS.indexOf(hex[2 * i + 1].toLowerCase());
    if (hi < 0 || lo < 0) throw new Error('SecureKeyStore: stored key is not valid hex');
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/**
 * KeyStorePort over expo-secure-store (iOS Keychain / Android Keystore,
 * hardware-backed where the device offers it).
 *
 * The native module is INJECTED - this package never imports it, so the
 * package stays hermetic and unit-testable. The app wires the real module:
 *
 *   new SecureKeyStore(SecureStore, {
 *     storeOptions: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
 *   })
 *
 * Only the 32-byte secret key is persisted (hex); the public key is derived
 * on load. Corrupt/foreign values fail closed (throw) rather than minting a
 * new identity over someone else's slot.
 *
 * Real device persistence needs the native module linked, which Expo dev
 * builds provide (Expo Go / bare node do NOT - the app falls back to
 * MemoryKeyStore there). The app wires this class in
 * apps/mobile/services/airplane/identity.ts (defaultKeyStore).
 */
export class SecureKeyStore implements KeyStorePort {
  private readonly adapter: SecureStoreLike;
  private readonly itemKey: string;
  private readonly storeOptions?: SecureStoreItemOptions;

  constructor(adapter: SecureStoreLike, opts: SecureKeyStoreOpts = {}) {
    this.adapter = adapter;
    this.itemKey = opts.itemKey ?? 'airplane.mesh.identity.v1';
    this.storeOptions = opts.storeOptions;
  }

  generateKeypair(): DeviceKeypair {
    const secretKey = ed25519.utils.randomSecretKey();
    return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
  }

  async storeKeypair(kp: DeviceKeypair): Promise<void> {
    checkKeypair(kp, 'SecureKeyStore.storeKeypair');
    await this.adapter.setItemAsync(this.itemKey, toHex(kp.secretKey), this.storeOptions);
  }

  async loadKeypair(): Promise<DeviceKeypair | null> {
    const stored = await this.adapter.getItemAsync(this.itemKey);
    if (stored === null) return null;
    const secretKey = fromHex(stored); // throws on corrupt values: fail closed
    return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
  }

  async sign(msg: Uint8Array): Promise<Uint8Array> {
    const kp = await this.loadKeypair();
    if (!kp) throw new Error('SecureKeyStore.sign: no keypair stored');
    return ed25519.sign(msg, kp.secretKey);
  }

  async getPublicKey(): Promise<Uint8Array | null> {
    const kp = await this.loadKeypair();
    return kp ? kp.publicKey : null;
  }

  /** Remove the persisted key (settings "burn identity" flow, P2). */
  async wipeKeypair(): Promise<void> {
    await this.adapter.deleteItemAsync(this.itemKey);
  }
}
