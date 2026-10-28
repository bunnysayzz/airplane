// SPDX-License-Identifier: Apache-2.0
// App DM singleton tests: a rejected creation must not poison the
// singleton (D10). The relay is stubbed so no real socket ever opens.

import { MemoryKeyStore } from '@airplane/crypto';

jest.mock('@airplane/transport', () => {
  const actual = jest.requireActual('@airplane/transport') as Record<string, unknown>;
  return {
    ...actual,
    WsDmRelay: class {
      async publish(): Promise<boolean> {
        return false;
      }
      subscribe(): () => void {
        return () => {};
      }
    },
  };
});

import { dmPeerLabel, getDmService, __resetDmServiceForTests } from './dm';
import { __resetDeviceKeypairForTests, setKeyStore } from './identity';
import { authorLabelFor } from './names';
import { dmFromHex } from '@airplane/transport';

class FailingLoadStore extends MemoryKeyStore {
  override async loadKeypair(): Promise<null> {
    throw new Error('keystore load exploded');
  }
}

beforeEach(() => {
  __resetDeviceKeypairForTests();
  __resetDmServiceForTests();
});

afterEach(() => {
  __resetDeviceKeypairForTests();
  __resetDmServiceForTests();
});

describe('dmPeerLabel (F20)', () => {
  test('a valid peer hex gets the feed author label, garbage falls back to anon', () => {
    const hex = 'ab'.repeat(32);
    const bytes = dmFromHex(hex);
    expect(bytes).not.toBeNull();
    expect(dmPeerLabel(hex)).toBe(authorLabelFor(bytes!));
    expect(dmPeerLabel('garbage')).toBe('anon·garb');
  });
});

describe('getDmService rejection recovery (D10)', () => {
  test('a failed creation clears the cached promise so the next call retries', async () => {
    setKeyStore(new FailingLoadStore());
    await expect(getDmService()).rejects.toThrow('keystore load exploded');
    // Without the fix, this second call would return the same rejected
    // promise forever and DM would stay dead until an app restart.
    __resetDeviceKeypairForTests();
    setKeyStore(new MemoryKeyStore());
    const svc = await getDmService();
    expect(svc).toBeDefined();
    await expect(getDmService()).resolves.toBe(svc);
  });
});
