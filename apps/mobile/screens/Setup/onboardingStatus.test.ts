// SPDX-License-Identifier: Apache-2.0
// Unit tests for the first-launch onboarding gate. The gating contract is:
// a fresh install (no flag persisted) must see Setup once; after
// markOnboardingDone() the flag is durable, so returning users skip Setup and
// land straight in the feed. The index route (`app/index.tsx`) drives this via
// hasCompletedOnboarding()/markOnboardingDone().

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) =>
        store.has(key) ? (store.get(key) as string) : null,
      ),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      // Test-only seam: reset the persisted flag between cases.
      __clear: () => store.clear(),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorageMock = require('@react-native-async-storage/async-storage')
  .default as { __clear: () => void };

import { hasCompletedOnboarding, markOnboardingDone } from './onboardingStatus';

beforeEach(() => {
  AsyncStorageMock.__clear();
  jest.clearAllMocks();
});

describe('first-launch onboarding gate', () => {
  it('a fresh install has not completed onboarding (Setup must show)', async () => {
    await expect(hasCompletedOnboarding()).resolves.toBe(false);
  });

  it('markOnboardingDone persists the flag (returning users skip Setup)', async () => {
    await markOnboardingDone();
    await expect(hasCompletedOnboarding()).resolves.toBe(true);
  });

  it('marking done is idempotent: completing twice still lands in the feed', async () => {
    await markOnboardingDone();
    await markOnboardingDone();
    await expect(hasCompletedOnboarding()).resolves.toBe(true);
  });

  it('the flag survives a fresh read of the store (durability, not memory)', async () => {
    await markOnboardingDone();
    // A new "boot" reads straight from persisted storage, not module state.
    await expect(hasCompletedOnboarding()).resolves.toBe(true);
  });

  it('a failed persist does not claim completion (Setup retries next launch)', async () => {
    // The store throws on write: markOnboardingDone propagates (Setup catches
    // and still completes the screen), and the flag stays false so the next
    // launch shows Setup again instead of silently skipping it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage')
      .default as { setItem: jest.Mock };
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(markOnboardingDone()).rejects.toThrow('disk full');
    await expect(hasCompletedOnboarding()).resolves.toBe(false);
  });
});
