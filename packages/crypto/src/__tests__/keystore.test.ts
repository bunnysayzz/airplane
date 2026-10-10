// SPDX-License-Identifier: Apache-2.0
// KeyStorePort behavior tests: keygen format, sign/verify round-trip, and
// stability across a re-instantiated keystore ("restart").

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  MemoryKeyStore,
  SecureKeyStore,
  loadOrGenerateKeypair,
  type SecureStoreLike,
} from '../keystore';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe('MemoryKeyStore', () => {
  test('generateKeypair emits 32-byte pubkey/secretKey', () => {
    const ks = new MemoryKeyStore();
    const kp = ks.generateKeypair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toHaveLength(32);
    // Two generations must differ (CSPRNG).
    const kp2 = ks.generateKeypair();
    expect(bytesEqual(kp.publicKey, kp2.publicKey)).toBe(false);
  });

  test('sign/verify round-trip over the stored key', async () => {
    const ks = new MemoryKeyStore();
    await expect(ks.sign(new Uint8Array([1]))).rejects.toThrow(/no keypair/);
    const kp = await loadOrGenerateKeypair(ks);
    const msg = new TextEncoder().encode('mesh identity test');
    const sig = await ks.sign(msg);
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, msg, kp.publicKey)).toBe(true);
    // Wrong key does not verify.
    const other = ks.generateKeypair();
    expect(ed25519.verify(sig, msg, other.publicKey)).toBe(false);
  });

  test('loadOrGenerate is stable across a re-instantiated keystore (restart)', async () => {
    const backing = new Map<string, Uint8Array>();
    const before = await loadOrGenerateKeypair(new MemoryKeyStore(backing));
    // "Restart": brand-new instance over the same persistence.
    const after = await loadOrGenerateKeypair(new MemoryKeyStore(backing));
    expect(bytesEqual(before.publicKey, after.publicKey)).toBe(true);
    expect(bytesEqual(before.secretKey, after.secretKey)).toBe(true);
  });

  test('getPublicKey is null before first generation', async () => {
    const ks = new MemoryKeyStore();
    expect(await ks.getPublicKey()).toBeNull();
    expect(await ks.loadKeypair()).toBeNull();
    await loadOrGenerateKeypair(ks);
    expect(await ks.getPublicKey()).toHaveLength(32);
  });

  test('storeKeypair rejects malformed key material', async () => {
    const ks = new MemoryKeyStore();
    await expect(
      ks.storeKeypair({ publicKey: new Uint8Array(31), secretKey: new Uint8Array(32) }),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe('SecureKeyStore', () => {
  /** Fake expo-secure-store adapter: a plain Map behind the real interface. */
  function fakeAdapter(): SecureStoreLike & { items: Map<string, string> } {
    const items = new Map<string, string>();
    return {
      items,
      getItemAsync: async (k: string) => (items.has(k) ? items.get(k)! : null),
      setItemAsync: async (k: string, v: string) => {
        items.set(k, v);
      },
      deleteItemAsync: async (k: string) => {
        items.delete(k);
      },
    };
  }

  test('round-trips a keypair through the adapter; stable across instances', async () => {
    const adapter = fakeAdapter();
    const before = await loadOrGenerateKeypair(new SecureKeyStore(adapter));
    expect(before.publicKey).toHaveLength(32);
    expect(before.secretKey).toHaveLength(32);
    // Only the secret key is persisted (hex); pubkey is derived on load.
    expect(adapter.items.get('airplane.mesh.identity.v1')).toMatch(/^[0-9a-f]{64}$/);

    const after = await loadOrGenerateKeypair(new SecureKeyStore(adapter));
    expect(bytesEqual(before.publicKey, after.publicKey)).toBe(true);

    const sig = await new SecureKeyStore(adapter).sign(new TextEncoder().encode('x'));
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, new TextEncoder().encode('x'), before.publicKey)).toBe(true);
  });

  test('fails closed on corrupt stored values', async () => {
    const adapter = fakeAdapter();
    adapter.items.set('airplane.mesh.identity.v1', 'not-hex-at-all');
    await expect(new SecureKeyStore(adapter).loadKeypair()).rejects.toThrow();
  });

  test('getPublicKey null before first generation; wipeKeypair clears', async () => {
    const adapter = fakeAdapter();
    const ks = new SecureKeyStore(adapter);
    expect(await ks.getPublicKey()).toBeNull();
    await loadOrGenerateKeypair(ks);
    expect(await ks.getPublicKey()).toHaveLength(32);
    await ks.wipeKeypair();
    expect(await ks.getPublicKey()).toBeNull();
  });

  test('setItemAsync receives the caller-supplied store options', async () => {
    const seen: Array<unknown> = [];
    const adapter = fakeAdapter();
    const orig = adapter.setItemAsync;
    adapter.setItemAsync = async (k, v, o) => {
      seen.push(o);
      await orig(k, v, o);
    };
    await loadOrGenerateKeypair(
      new SecureKeyStore(adapter, { storeOptions: { keychainAccessible: 1 } }),
    );
    expect(seen).toEqual([{ keychainAccessible: 1 }]);
  });
});
