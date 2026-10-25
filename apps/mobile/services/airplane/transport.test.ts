// SPDX-License-Identifier: Apache-2.0
// Transport manager lifecycle tests. WebSocket is stubbed so no real relay
// connections are attempted; NetInfo is the repo's __mocks__ version.

import NetInfo from '@react-native-community/netinfo';
import { startTransport, stopTransport, publishViaTransport, __resetNetInfoForTests, __getHybridForTests, getBleRadioState, blePeerIdsForPublish, resolveRelayState, getMeshStatus } from './transport';
import { getStore, __resetStoreForTests } from './store';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require('react-native') as {
  PermissionsAndroid: { request: jest.Mock; check: jest.Mock };
};

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

  test('online event schedules the periodic sync timer exactly once', async () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    await startTransport();
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;

    listener({ isConnected: true, isInternetReachable: true });
    listener({ isConnected: true, isInternetReachable: true }); // duplicate
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    setIntervalSpy.mockRestore();
  });

  test('offline event clears the sync timer; duplicate offline is a no-op', async () => {
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    await startTransport();
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;

    listener({ isConnected: true, isInternetReachable: true });
    listener({ isConnected: false, isInternetReachable: false });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    listener({ isConnected: false, isInternetReachable: false }); // duplicate
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  test('initial online state schedules the sync timer', async () => {
    netInfoMock.fetch.mockResolvedValue({ isConnected: true, isInternetReachable: true });
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    await startTransport();
    // Wait for the async initial-state check inside startTransport.
    await Promise.resolve();
    await Promise.resolve();
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test('initial fetch resolving online after an offline listener event restarts Nostr', async () => {
    // NetInfo reports isInternetReachable as not-yet-known until its
    // reachability check lands, so the listener can fire offline first
    // and the initial fetch resolve online after. The fetch path must
    // restart Nostr, not just the sync timer — otherwise the silent
    // WorldSync uplink stays dead until the next connectivity flap.
    type NetState = { isConnected: boolean; isInternetReachable: boolean };
    let resolveFetch: ((s: NetState) => void) | null = null;
    netInfoMock.fetch.mockImplementation(
      () =>
        new Promise<NetState>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const nostrStartSpy = jest.spyOn(hybrid!.nostr, 'start');
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: NetState) => void;
    // Listener fires offline first (reachability still unknown).
    listener({ isConnected: true, isInternetReachable: false });
    // Then the initial fetch resolves online.
    resolveFetch!({ isConnected: true, isInternetReachable: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(nostrStartSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test('duplicate online events start Nostr only once', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const nostrStartSpy = jest.spyOn(hybrid!.nostr, 'start');
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;
    listener({ isConnected: true, isInternetReachable: true });
    listener({ isConnected: true, isInternetReachable: true }); // duplicate
    expect(nostrStartSpy).toHaveBeenCalledTimes(1);
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

  // BLE permission priming (prod-14): the OS dialog must never fire at
  // startup. startTransport only *checks* the grants; the request happens
  // later, on the user's explicit action via enableBleRadio().
  test('BLE radio stays down without prompting when permission is missing', async () => {
    RN.PermissionsAndroid.check.mockReset();
    RN.PermissionsAndroid.check.mockResolvedValue(false);
    RN.PermissionsAndroid.request.mockClear();
    await startTransport();
    expect(getBleRadioState()).toBe('permission-blocked');
    expect(RN.PermissionsAndroid.request).not.toHaveBeenCalled();
    // Restore the mock default for the remaining tests.
    RN.PermissionsAndroid.check.mockResolvedValue(true);
  });

  test('BLE radio bring-up is silent when permission is already granted', async () => {
    RN.PermissionsAndroid.check.mockReset();
    RN.PermissionsAndroid.check.mockResolvedValue(true);
    await startTransport();
    // No native BLE stack in jest: advertise fails closed to 'unavailable'.
    // The point is the check-first path ran without wedging the transport.
    expect(getBleRadioState()).toBe('unavailable');
    expect(__getHybridForTests()).not.toBeNull();
  });
});

describe('BLE publish targets + mesh status', () => {
  test('blePeerIdsForPublish returns connected ids, [] otherwise', () => {
    expect(blePeerIdsForPublish(null)).toEqual([]);
    expect(blePeerIdsForPublish(undefined)).toEqual([]);
    expect(blePeerIdsForPublish({} as never)).toEqual([]);
    expect(blePeerIdsForPublish({ connectedPeerIds: () => ['a', 'b'] } as never)).toEqual(['a', 'b']);
    expect(blePeerIdsForPublish({ connectedPeerIds: () => { throw new Error('boom'); } } as never)).toEqual([]);
  });

  test('resolveRelayState truth table', () => {
    expect(resolveRelayState(true, 'on')).toBe('online');
    expect(resolveRelayState(true, 'permission-blocked')).toBe('online');
    expect(resolveRelayState(false, 'on')).toBe('mesh');
    expect(resolveRelayState(false, 'starting')).toBe('mesh');
    expect(resolveRelayState(false, 'permission-blocked')).toBe('offline');
    expect(resolveRelayState(false, 'unavailable')).toBe('offline');
  });

  test('getMeshStatus after stopTransport reports 0 peers and offline', () => {
    stopTransport();
    const s = getMeshStatus();
    expect(s.peersNearby).toBe(0);
    expect(s.relayState).toBe('offline');
  });
});
