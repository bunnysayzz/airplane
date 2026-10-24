// SPDX-License-Identifier: Apache-2.0
// Tests for the identity service's keystore wiring: which keystore becomes
// the default (expo-secure-store when the native module is linked, in-memory
// fallback otherwise), the injection seam, the module-level cache, the
// concurrency guard on cold start, and restart persistence.

import { MemoryKeyStore } from '@airplane/crypto';
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
describe('concurrency guard and restart persistence', () => {
  /**
   * In-memory keystore with an artificially slow load (50 ms) and a
   * counted generateKeypair - reproduces the check-then-act window where
   * N concurrent getDeviceKeypair() calls would previously each mint their
   * own keypair (split identity, data-loss class).
   */
  class SlowCountingKeyStore extends MemoryKeyStore {
    generations = 0;
    override generateKeypair(): DeviceKeypair {
      this.generations += 1;
      return super.generateKeypair();
    }
    override async loadKeypair(): Promise<DeviceKeypair | null> {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return super.loadKeypair();
    }
  }

  test('5 concurrent cold-start calls mint exactly one keypair, shared by all', async () => {
    const mod = await freshIdentity();
    const ks = new SlowCountingKeyStore();
    mod.__resetDeviceKeypairForTests();
    mod.setKeyStore(ks);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => mod.getDeviceKeypair()),
    );
    expect(ks.generations).toBe(1);
    const pkHex = Buffer.from(results[0].publicKey).toString('hex');
    for (const kp of results) {
      expect(Buffer.from(kp.publicKey).toString('hex')).toBe(pkHex);
    }
  });

  test('a rejection mid-flight clears inflight so the next call retries', async () => {
    const mod = await freshIdentity();
    let attempts = 0;
    const flaky: KeyStorePort = {
      generateKeypair: () => {
        attempts += 1;
        throw new Error('keystore exploded');
      },
      storeKeypair: async () => {},
      loadKeypair: async () => null,
      sign: async () => new Uint8Array(64),
      getPublicKey: async () => null,
    };
    mod.__resetDeviceKeypairForTests();
    mod.setKeyStore(flaky);
    await expect(mod.getDeviceKeypair()).rejects.toThrow('keystore exploded');
    // The failed promise must not be cached: this call retries (and fails
    // again on its own), proving inflight was cleared.
    await expect(mod.getDeviceKeypair()).rejects.toThrow('keystore exploded');
    expect(attempts).toBe(2);
  });

  test('identity persists across a simulated restart with a shared backing store', async () => {
    const mod = await freshIdentity();
    const backing = new Map<string, Uint8Array>();
    mod.setKeyStore(new MemoryKeyStore(backing));
    const first = await mod.getDeviceKeypair();
    // "Restart": drop the module cache and re-instantiate the keystore over
    // the SAME backing map, like a new process would.
    mod.setKeyStore(new MemoryKeyStore(backing));
    const second = await mod.getDeviceKeypair();
    expect(second).not.toBe(first); // re-loaded from the store, not the cache
    expect(second.publicKey).toEqual(first.publicKey);
    expect(second.secretKey).toEqual(first.secretKey);
  });

  test('__resetDeviceKeypairForTests clears an in-flight load too', async () => {
    const mod = await freshIdentity();
    mod.setKeyStore(new SlowCountingKeyStore());
    const pending = mod.getDeviceKeypair(); // starts the slow load
    mod.__resetDeviceKeypairForTests(); // simulates a burn mid-flight
    await pending;
    // The cache still holds the burned identity until the next call, which
    // must NOT reuse the cleared in-flight promise.
    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
  });
});
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

describe('secure-store call-time failure fallback (T1)', () => {
  /**
   * The real-device failure class: expo-secure-store RESOLVES at require
   * time (so defaultKeyStore() picks it) but its native module is broken,
   * so getItemAsync throws at CALL time. Posting must survive via the
   * in-memory fallback instead of failing with the generic publish error.
   */
  function throwingAdapter() {
    const adapter = makeAdapter();
    adapter.getItemAsync = async () => {
      throw new Error('SecureStore: native module is not available');
    };
    return adapter;
  }

  test('falls back to the in-memory store when the secure store throws at call time', async () => {
    const adapter = throwingAdapter();
    const mod = await freshIdentity(() => adapter);
    const kp = await mod.getDeviceKeypair();
    expect(kp.publicKey).toHaveLength(32);
    expect(kp.secretKey).toHaveLength(32);
    // Nothing was persisted through the broken secure store.
    expect(adapter.items.has('airplane.mesh.identity.v1')).toBe(false);
    // Cached: the same object serves the rest of the session.
    expect(await mod.getDeviceKeypair()).toBe(kp);
    // A breadcrumb records that the fallback fired (same fresh module
    // instance identity.ts imported after the registry reset).
    const sentry = await import('../../src/sentry');
    expect(sentry.__getBreadcrumbsForTests()).toContainEqual(
      expect.objectContaining({ message: 'keystore-fallback' }),
    );
  });

  test('fallback identity is ephemeral: a fresh module load mints a different keypair', async () => {
    const adapter = throwingAdapter();
    const first = await (await freshIdentity(() => adapter)).getDeviceKeypair();
    const second = await (
      await freshIdentity(() => adapter)
    ).getDeviceKeypair();
    expect(Buffer.from(second.publicKey).toString('hex')).not.toBe(
      Buffer.from(first.publicKey).toString('hex'),
    );
  });

  test('an injected throwing store still fails loud (no fallback for explicit injection)', async () => {
    const mod = await freshIdentity();
    const broken: KeyStorePort = {
      generateKeypair: () => {
        throw new Error('injected store exploded');
      },
      storeKeypair: async () => {},
      loadKeypair: async () => {
        throw new Error('injected store exploded');
      },
      sign: async () => new Uint8Array(64),
      getPublicKey: async () => null,
    };
    mod.setKeyStore(broken);
    await expect(mod.getDeviceKeypair()).rejects.toThrow(
      'injected store exploded',
    );
  });
});
