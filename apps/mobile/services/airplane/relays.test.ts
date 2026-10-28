// SPDX-License-Identifier: Apache-2.0
// Relay configurability tests: persistence round-trip, add/remove
// behaviour, and defaults intact when uncustomized. AsyncStorage is mocked
// with an in-memory Map (same pattern as onboardingStatus.test.ts); no
// real storage or network is touched.

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (store.has(key) ? (store.get(key) as string) : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      // Test-only seams.
      __clear: () => store.clear(),
      __setRaw: (key: string, value: string) => store.set(key, value),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorageMock = require('@react-native-async-storage/async-storage').default as {
  __clear: () => void;
  __setRaw: (key: string, value: string) => void;
};

import {
  DEFAULT_RELAYS,
  RELAYS_KEY,
  addRelayUrl,
  loadRelayUrls,
  loadStoredRelays,
  normalizeRelayUrl,
  parseStoredRelays,
  removeRelayUrl,
  resetRelayUrls,
  saveRelayUrls,
  sanitizeRelayList,
} from '../../src/lib/relays';

beforeEach(() => {
  AsyncStorageMock.__clear();
  jest.clearAllMocks();
});

describe('relay list defaults', () => {
  it('loads the default public relays when nothing is stored', async () => {
    expect(await loadStoredRelays()).toBeNull();
    expect(await loadRelayUrls()).toEqual(DEFAULT_RELAYS);
    expect(DEFAULT_RELAYS).toEqual(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']);
  });

  it('falls back to defaults on a corrupt or non-array payload', async () => {
    AsyncStorageMock.__setRaw(RELAYS_KEY, 'not json at all');
    expect(await loadRelayUrls()).toEqual(DEFAULT_RELAYS);
    AsyncStorageMock.__setRaw(RELAYS_KEY, JSON.stringify({ relay: 'wss://x.relay' }));
    expect(await loadRelayUrls()).toEqual(DEFAULT_RELAYS);
    expect(parseStoredRelays('{{{')).toBeNull();
    expect(parseStoredRelays(JSON.stringify('wss://x.relay'))).toBeNull();
  });
});

describe('relay URL validation', () => {
  it('accepts wss:// URLs, trims whitespace and trailing slashes', () => {
    expect(normalizeRelayUrl('  wss://custom.relay/ ')).toBe('wss://custom.relay');
    expect(normalizeRelayUrl('wss://custom.relay')).toBe('wss://custom.relay');
  });

  it('rejects non-wss URLs, bare schemes and whitespace inside', () => {
    expect(normalizeRelayUrl('ws://plain.relay')).toBeNull();
    expect(normalizeRelayUrl('https://relay.example.com')).toBeNull();
    expect(normalizeRelayUrl('wss://')).toBeNull();
    expect(normalizeRelayUrl('wss://a b.relay')).toBeNull();
    expect(normalizeRelayUrl('')).toBeNull();
  });

  it('sanitize dedupes and drops invalid entries, preserving order', () => {
    expect(
      sanitizeRelayList(['wss://a.relay', 'ws://bad.relay', 'wss://a.relay/', 'wss://b.relay']),
    ).toEqual(['wss://a.relay', 'wss://b.relay']);
  });

  it('rejects credentials and bad ports, dedupes case and port variants', () => {
    expect(normalizeRelayUrl('wss://user:pass@a.relay')).toBeNull();
    expect(normalizeRelayUrl('wss://a.relay:99999')).toBeNull();
    expect(normalizeRelayUrl('WSS://A.RELAY:443/')).toBe('wss://a.relay');
    expect(sanitizeRelayList(['wss://A.relay', 'wss://a.relay:443'])).toEqual(['wss://a.relay']);
  });
});

describe('add/remove behaviour', () => {
  it('adds a valid relay and rejects duplicates and invalid URLs', () => {
    const base = ['wss://a.relay'];
    expect(addRelayUrl(base, 'wss://b.relay')).toEqual(['wss://a.relay', 'wss://b.relay']);
    expect(addRelayUrl(base, 'wss://a.relay')).toBeNull();
    expect(addRelayUrl(base, 'wss://a.relay/')).toBeNull();
    expect(addRelayUrl(base, 'http://nope.relay')).toBeNull();
    expect(base).toEqual(['wss://a.relay']); // pure: input untouched
  });

  it('removes a relay and no-ops on an absent one', () => {
    expect(removeRelayUrl(['wss://a.relay', 'wss://b.relay'], 'wss://a.relay')).toEqual([
      'wss://b.relay',
    ]);
    expect(removeRelayUrl(['wss://a.relay'], 'wss://gone.relay')).toEqual(['wss://a.relay']);
  });
});

describe('persistence round-trip', () => {
  it('a saved custom list loads back exactly, and survives a fresh read', async () => {
    const custom = ['wss://custom.relay', 'wss://relay.damus.io'];
    expect(await saveRelayUrls(custom)).toEqual(custom);
    expect(await loadStoredRelays()).toEqual(custom);
    // A new "boot" reads straight from persisted storage, not module state.
    expect(await loadRelayUrls()).toEqual(custom);
  });

  it('an explicitly empty list persists as empty, not as defaults', async () => {
    await saveRelayUrls([]);
    expect(await loadStoredRelays()).toEqual([]);
    expect(await loadRelayUrls()).toEqual([]);
  });

  it('reset forgets the custom list and defaults return', async () => {
    await saveRelayUrls(['wss://custom.relay']);
    expect(await loadRelayUrls()).toEqual(['wss://custom.relay']);
    await resetRelayUrls();
    expect(await loadStoredRelays()).toBeNull();
    expect(await loadRelayUrls()).toEqual(DEFAULT_RELAYS);
  });

  it('saving drops invalid and duplicate entries before persisting', async () => {
    await saveRelayUrls(['wss://a.relay', 'ws://bad.relay', 'wss://a.relay']);
    expect(await loadRelayUrls()).toEqual(['wss://a.relay']);
  });
});
