// SPDX-License-Identifier: Apache-2.0
// Tests for the identity service's keystore wiring: which keystore becomes
// the default (expo-secure-store when the native module is linked, in-memory
// fallback otherwise), the injection seam, and the module-level cache.

import type {
  DeviceKeypair,
  KeyStorePort,
  SecureStoreLike,
} from '@airplane/crypto';

/** Fake expo-secure-store adapter: a plain Map behind the real interface. */
function makeAdapter(extra: Record<string, unknown> = {}): SecureStoreLike & {
  items: Map<string, string>;
} {
  const items = new Map<string, string>();
  return {
    items,
    ...extra,
    getItemAsync: async (k: string) => (items.has(k) ? items.get(k)! : null),
    setItemAsync: async (k: string, v: string) => {
      items.set(k, v);
    },
    deleteItemAsync: async (k: string) => {
      items.delete(k);
    },
  };
}

/**
 * Import a fresh copy of the identity module, optionally with
 * 'expo-secure-store' mocked. Resets the module registry first so the
 * lazy require() inside defaultKeyStore() sees the mock (or its absence).
 */
async function freshIdentity(mockFactory?: () => unknown) {
  jest.resetModules();
  if (mockFactory) {
    jest.doMock('expo-secure-store', mockFactory, { virtual: true });
  }
  const mod = await import('./identity');
  mod.__resetDeviceKeypairForTests();
  return mod;
}

afterEach(() => {
  jest.dontMock('expo-secure-store');
  jest.resetModules();
});

describe('default keystore selection', () => {
  test('uses expo-secure-store with AFTER_FIRST_UNLOCK when the native module is linked', async () => {
    const adapter = makeAdapter({ AFTER_FIRST_UNLOCK: 1 });
    const mod = await freshIdentity(() => adapter);

    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
    // Persisted through the secure-store adapter under the default item key.
    expect(adapter.items.has('airplane.mesh.identity.v1')).toBe(true);
    expect(adapter.items.get('airplane.mesh.identity.v1')).toMatch(/^[0-9a-f]{64}$/);

    // The keypair is cached at module scope: same object, no re-read.
    const kp2 = await mod.getDeviceKeypair();
    expect(kp2).toBe(kp);
  });

  test('works when AFTER_FIRST_UNLOCK is undefined (storeOptions omitted)', async () => {
    const adapter = makeAdapter();
    const mod = await freshIdentity(() => adapter);
    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(adapter.items.has('airplane.mesh.identity.v1')).toBe(true);
  });

  test('falls back to the in-memory store when require throws (not linked)', async () => {
    const mod = await freshIdentity(() => {
      throw new Error('native module not linked');
    });
    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toHaveLength(32);
  });

  test('falls back to the in-memory store when the module is absent entirely', async () => {
    const mod = await freshIdentity(); // no mock at all
    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
  });
});

describe('injection seam and cache', () => {
  const fixed: DeviceKeypair = {
    publicKey: new Uint8Array(32).fill(9),
    secretKey: new Uint8Array(32).fill(8),
  };
  const stub: KeyStorePort = {
    generateKeypair: () => fixed,
    storeKeypair: async () => {},
    loadKeypair: async () => fixed,
    sign: async () => new Uint8Array(64),
    getPublicKey: async () => fixed.publicKey,
  };

  test('an injected keystore wins over the default', async () => {
    const mod = await freshIdentity();
    const fromDefault = await mod.getDeviceKeypair();
    mod.setKeyStore(stub); // also clears the cache
    const fromInjected = await mod.getDeviceKeypair();
    expect(fromInjected).toBe(fixed);
    expect(fromInjected).not.toBe(fromDefault);
  });

  test('__resetDeviceKeypairForTests drops the injected keystore too', async () => {
    const mod = await freshIdentity();
    mod.setKeyStore(stub);
    expect(await mod.getDeviceKeypair()).toBe(fixed);
    mod.__resetDeviceKeypairForTests();
    const after = await mod.getDeviceKeypair();
    expect(after).not.toBe(fixed); // back on the default keystore
    expect(after.publicKey).toHaveLength(32);
  });

  test('setKeyStore(null) restores the default', async () => {
    const mod = await freshIdentity();
    mod.setKeyStore(stub);
    expect(await mod.getDeviceKeypair()).toBe(fixed);
    mod.setKeyStore(null);
    const after = await mod.getDeviceKeypair();
    expect(after).not.toBe(fixed);
  });
});
