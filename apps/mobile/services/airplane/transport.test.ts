// SPDX-License-Identifier: Apache-2.0
// Transport manager lifecycle tests. WebSocket is stubbed so no real relay
// connections are attempted; NetInfo is the repo's __mocks__ version.

import NetInfo from '@react-native-community/netinfo';
import { startTransport, stopTransport, publishViaTransport, __resetNetInfoForTests, __getHybridForTests } from './transport';
import { getStore, __resetStoreForTests } from './store';

/** Fake WebSocket that never connects - records constructor calls only. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readyState = 0;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

const netInfoMock = NetInfo as unknown as {
  fetch: jest.Mock;
  addEventListener: jest.Mock;
};

function makeSignedEvent(): import('@airplane/protocol').SignedEvent {
  const id = new Uint8Array(32).fill(7);
  return {
    id,
    pubkey: new Uint8Array(32).fill(1),
    created_at: 1_700_000_000,
    kind: 1,
    geohash: 'ezs42',
    tags: [],
    content: 'transport test',
    sig: new Uint8Array(64).fill(3),
  };
}

describe('transport manager', () => {
  let realWebSocket: unknown;

  beforeEach(() => {
    realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
    (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
    FakeSocket.instances = [];
    netInfoMock.fetch.mockResolvedValue({ isConnected: false, isInternetReachable: false });
    netInfoMock.addEventListener.mockClear();
    netInfoMock.addEventListener.mockReturnValue(jest.fn());
    __resetStoreForTests();
    __resetNetInfoForTests();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Clean up while fake timers are still active so mocked setTimeout/
    // setInterval handles are properly cleared.
    jest.clearAllTimers();
    await stopTransport();
    jest.useRealTimers();
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    jest.restoreAllMocks();
  });

  test('startTransport registers a NetInfo listener', async () => {
    await startTransport();
    expect(netInfoMock.addEventListener).toHaveBeenCalledTimes(1);
    expect(typeof netInfoMock.addEventListener.mock.calls[0][0]).toBe('function');
  });

  test('startTransport is idempotent - second call is a no-op', async () => {
    await startTransport();
    await startTransport();
    expect(netInfoMock.addEventListener).toHaveBeenCalledTimes(1);
  });

  test('stopTransport unsubscribes the NetInfo listener', async () => {
    const unsub = jest.fn();
    netInfoMock.addEventListener.mockReturnValue(unsub);
    await startTransport();
    await stopTransport();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  test('stopTransport without start does not throw', async () => {
    await expect(stopTransport()).resolves.toBeUndefined();
  });

  test('startTransport after stopTransport re-registers the listener', async () => {
    await startTransport();
    await stopTransport();
    netInfoMock.addEventListener.mockClear();
    await startTransport();
    expect(netInfoMock.addEventListener).toHaveBeenCalledTimes(1);
  });

  test('offline initial state does not start the sync timer', async () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    await startTransport();
    // NetInfo mock reports offline; no periodic sync should be scheduled.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test('online event triggers nostr start without throwing', async () => {
    await startTransport();
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;
    // Simulate coming online then going offline - must not throw.
    expect(() =>
      listener({ isConnected: true, isInternetReachable: true }),
    ).not.toThrow();
    expect(() =>
      listener({ isConnected: false, isInternetReachable: false }),
    ).not.toThrow();
    // Flush pending promises.
    await Promise.resolve();
  });

  test('publishViaTransport auto-starts and returns a result', async () => {
    const result = await publishViaTransport(makeSignedEvent());
    expect(result).toHaveProperty('blePeers');
    expect(result).toHaveProperty('relays');
    expect(Array.isArray(result.relays)).toBe(true);
  });

  test('startTransport survives NetInfo native module load failure', async () => {
    // Simulate a broken/missing native module: require throws.
    jest.resetModules();
    jest.doMock('@react-native-community/netinfo', () => {
      throw new Error('native module not linked');
    });
    // Re-import the transport module fresh so it picks up the throwing mock.
    const fresh = await import('./transport');
    fresh.__resetNetInfoForTests();
    // Must not throw — app launches in offline-only mode.
    await expect(fresh.startTransport()).resolves.toBeUndefined();
    await fresh.stopTransport();
    jest.dontMock('@react-native-community/netinfo');
  });

  test('startTransport survives NetInfo addEventListener throwing', async () => {
    // Module loads fine, but listener registration blows up (native quirk).
    netInfoMock.addEventListener.mockImplementation(() => {
      throw new Error('listener boom');
    });
    await expect(startTransport()).resolves.toBeUndefined();
  });

  test('relay-observed inbound posts are World-confirmed; ble ones are not', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();

    const relayEvent = makeSignedEvent();
    const relayId = '07'.repeat(32);
    hybrid!.ingress(relayEvent, 'nostr');
    // confirmListener is async: flush the promise chain.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const store = getStore();
    expect(await store.isWorldConfirmed(relayId)).toBe(true);

    const bleEvent = makeSignedEvent();
    bleEvent.id = new Uint8Array(32).fill(8);
    hybrid!.ingress(bleEvent, 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await store.isWorldConfirmed('08'.repeat(32))).toBe(false);
  });
});
