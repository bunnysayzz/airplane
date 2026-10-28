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

describe('loadOrGenerateKeypair paths', () => {
  test('returns the stored keypair WITHOUT minting a new one', async () => {
    const backing = new Map<string, Uint8Array>();
    const ks = new MemoryKeyStore(backing);
    const kp = ks.generateKeypair();
    await ks.storeKeypair(kp);
    const before = backing.get('mesh-keypair')!.slice();

    const loaded = await loadOrGenerateKeypair(new MemoryKeyStore(backing));
    expect(bytesEqual(loaded.publicKey, kp.publicKey)).toBe(true);
    expect(bytesEqual(loaded.secretKey, kp.secretKey)).toBe(true);
    // The persisted bytes are untouched: no fresh keypair was generated.
    expect(bytesEqual(backing.get('mesh-keypair')!, before)).toBe(true);
  });

  test('generates and persists on first use; second call hits the stored key', async () => {
    const ks = new MemoryKeyStore();
    const kp = await loadOrGenerateKeypair(ks);
    expect(kp.publicKey).toHaveLength(32);
    const again = await loadOrGenerateKeypair(ks);
    expect(bytesEqual(again.secretKey, kp.secretKey)).toBe(true);
  });
});

describe('key validation edges', () => {
  test('MemoryKeyStore.storeKeypair rejects a short secretKey', async () => {
    const ks = new MemoryKeyStore();
    const kp = ks.generateKeypair();
    await expect(
      ks.storeKeypair({ publicKey: kp.publicKey, secretKey: new Uint8Array(31) }),
    ).rejects.toThrow(/secretKey must be 32 bytes/);
  });

  test('SecureKeyStore.storeKeypair rejects a short secretKey', async () => {
    const ks = new SecureKeyStore(fakeAdapter());
    const kp = ks.generateKeypair();
    await expect(
      ks.storeKeypair({ publicKey: kp.publicKey, secretKey: new Uint8Array(31) }),
    ).rejects.toThrow(/secretKey must be 32 bytes/);
  });

  test('SecureKeyStore.storeKeypair rejects a non-Uint8Array publicKey', async () => {
    const ks = new SecureKeyStore(fakeAdapter());
    const kp = ks.generateKeypair();
    await expect(
      ks.storeKeypair({
        publicKey: Array.from(kp.publicKey) as unknown as Uint8Array,
        secretKey: kp.secretKey,
      }),
    ).rejects.toThrow(/publicKey must be 32 bytes/);
  });

  test('SecureKeyStore fails closed on 64-char non-hex stored value', async () => {
    const adapter = fakeAdapter();
    adapter.items.set('airplane.mesh.identity.v1', 'zz'.repeat(32));
    await expect(new SecureKeyStore(adapter).loadKeypair()).rejects.toThrow(/valid hex/);
  });

  test('SecureKeyStore fails closed on wrong-length hex stored value', async () => {
    const adapter = fakeAdapter();
    adapter.items.set('airplane.mesh.identity.v1', 'ab'.repeat(31));
    await expect(new SecureKeyStore(adapter).loadKeypair()).rejects.toThrow(
      /not 32 bytes hex/,
    );
  });

  test('SecureKeyStore tolerates uppercase hex (written by a foreign writer)', async () => {
    const adapter = fakeAdapter();
    const ks = new SecureKeyStore(adapter);
    const kp = ks.generateKeypair();
    const hex = Array.from(kp.secretKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    adapter.items.set('airplane.mesh.identity.v1', hex);
    const loaded = await new SecureKeyStore(adapter).loadKeypair();
    expect(loaded).not.toBeNull();
    expect(bytesEqual(loaded!.publicKey, kp.publicKey)).toBe(true);
  });

  test('SecureKeyStore custom itemKey is honored', async () => {
    const adapter = fakeAdapter();
    const ks = new SecureKeyStore(adapter, { itemKey: 'custom.key' });
    await loadOrGenerateKeypair(ks);
    expect(adapter.items.has('custom.key')).toBe(true);
    expect(adapter.items.has('airplane.mesh.identity.v1')).toBe(false);
  });

  test('SecureKeyStore.wipeKeypair on an empty store does not throw', async () => {
    const adapter = fakeAdapter();
    await expect(new SecureKeyStore(adapter).wipeKeypair()).resolves.toBeUndefined();
    expect(await new SecureKeyStore(adapter).getPublicKey()).toBeNull();
  });

  test('MemoryKeyStore.sign after wipe is impossible (no keypair stored)', async () => {
    // MemoryKeyStore has no wipe; emulate by using a fresh empty backing.
    const ks = new MemoryKeyStore(new Map());
    await expect(ks.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no keypair/);
  });
});
