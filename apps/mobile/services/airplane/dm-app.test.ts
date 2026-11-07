// SPDX-License-Identifier: Apache-2.0
// App DM singleton tests: a rejected creation must not poison the
// singleton (D10). The relay is stubbed so no real socket ever opens.

import { MemoryKeyStore } from '@airplane/crypto';

// DM wiring builds a SqliteDmStore over the app SQLite port, whose real
// executor is the native op-sqlite module (unloadable in Jest). Mock the
// port factory at the seam: the test only exercises singleton/rejection
// behaviour, never a real DM operation, and SqliteDmStore migrates
// lazily, so a stub port is enough.
jest.mock('./sqlite', () => ({
  createSqliteDatabasePort: () => ({
    exec: async () => {},
    query: async () => [],
    close: async () => {},
  }),
}));

jest.mock('@airplane/transport', () => {
  const actual = jest.requireActual('@airplane/transport') as Record<string, unknown>;
  return {
    ...actual,
    WsDmRelay: class {
      private readonly relayUrls: string[];
      constructor(opts: { relays: string[] }) {
        this.relayUrls = [...opts.relays];
      }
      getRelayUrls(): string[] {
        return [...this.relayUrls];
      }
      getRelayState(): 'closed' {
        return 'closed';
      }
      openRelayCount(): number {
        return 0;
      }
      async publish(): Promise<{ accepted: boolean; rejected: boolean }> {
        return { accepted: false, rejected: false };
      }
      async publishAck(): Promise<{ accepted: boolean; rejected: boolean }> {
        return { accepted: false, rejected: false };
      }
      subscribe(): () => void {
        return () => {};
      }
    },
  };
});

import { dmPeerLabel, dmUserErrorMessage, getDmRelayPoolHealth, getDmService, __resetDmServiceForTests } from './dm';
import { __resetDeviceKeypairForTests, setKeyStore } from './identity';
import { memorableNameFor } from './names';
import { __resetDisplayNamesForTests, recordPeerDisplayName } from './displayNames';
import { dmFromHex } from '@airplane/transport';

class FailingLoadStore extends MemoryKeyStore {
  override async loadKeypair(): Promise<null> {
    throw new Error('keystore load exploded');
  }
}

beforeEach(() => {
  __resetDeviceKeypairForTests();
  __resetDmServiceForTests();
  __resetDisplayNamesForTests();
});

afterEach(() => {
  __resetDeviceKeypairForTests();
  __resetDmServiceForTests();
  __resetDisplayNamesForTests();
});

describe('dmPeerLabel (F20)', () => {
  test('a valid peer hex gets the clean name (no hex suffix), garbage falls back to anon', () => {
    const hex = 'ab'.repeat(32);
    const bytes = dmFromHex(hex);
    expect(bytes).not.toBeNull();
    expect(dmPeerLabel(hex)).toBe(memorableNameFor(bytes!));
    expect(dmPeerLabel('garbage')).toBe('anon·garb');
  });

  test('a recorded signed display name wins over the memorable name', () => {
    const hex = 'ab'.repeat(32);
    recordPeerDisplayName(hex, 'tuba');
    expect(dmPeerLabel(hex)).toBe('tuba');
  });
});

describe('dmUserErrorMessage (F36)', () => {
  test('known errors map to friendly copy, unknown errors map to generic copy', () => {
    expect(dmUserErrorMessage(new Error('sendMessage: peer is blocked'))).toBe(
      'This conversation is blocked. Unblock it to send again.',
    );
    expect(dmUserErrorMessage(new Error('sendMessage: DM longer than 4096 bytes'))).toBe(
      'That message is too long to send.',
    );
    expect(dmUserErrorMessage(new Error('blockPeer: peer pubkey must be 64 lowercase hex chars'))).toBe(
      'That conversation key is not valid.',
    );
    // Raw internals (paths, keys, stack-shaped text) never reach the user.
    expect(dmUserErrorMessage(new Error('sqlite /data/data/app.db failed: key abc123'))).toBe(
      'Something went wrong. Try again.',
    );
    expect(dmUserErrorMessage('not an error')).toBe('Something went wrong. Try again.');
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

describe('getDmRelayPoolHealth (v0.1.31)', () => {
  test('null before the service starts, then the pool URLs with no open sockets', async () => {
    expect(getDmRelayPoolHealth()).toBeNull();
    const svc = await getDmService();
    expect(svc).toBeDefined();
    // The relay is stubbed, so no real socket ever opens: the pool
    // reports its URLs and zero open, which is what the mesh poll
    // reads as its DM leg.
    const health = getDmRelayPoolHealth();
    expect(health).not.toBeNull();
    expect(health!.urls.length).toBeGreaterThan(0);
    expect(health!.urls.every((u) => u.startsWith('wss://'))).toBe(true);
    expect(health!.openUrls).toEqual([]);
  });
});
