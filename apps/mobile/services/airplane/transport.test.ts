// SPDX-License-Identifier: Apache-2.0
// Transport manager lifecycle tests. WebSocket is stubbed so no real relay
// connections are attempted; NetInfo is the repo's __mocks__ version.
// AsyncStorage is mocked so the relay list startTransport() reads is fully
// under test control (empty store = defaults, seeded store = custom list).

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

import NetInfo from '@react-native-community/netinfo';
import { startTransport, stopTransport, publishViaTransport, pruneExpiredStore, drainPostOutbox, runWorldSyncPass, __resetTransportForTests, __setDrainRowDelayMsForTests, __resetNetInfoForTests, __resetPulledPostsForTests, __resetFailedInboundForTests, __getHybridForTests, __setBlePortForTests, getBleRadioState, blePeerIdsForPublish, resolveRelayState, getMeshStatus, subscribeMeshStatus, retryBleRadio, revalidateBleRadio } from './transport';
import { getStore, __resetStoreForTests } from './store';
import { subscribeFeed } from './feed';
import { __resetDeviceKeypairForTests } from './identity';
import {
  __resetResharesForTests,
  markResharePostKnown,
  reshareViewFor,
  toggleReshare,
} from './reshares';
import { NobleCrypto, createReshare, fromHex, toHex } from '@airplane/protocol';
import type { PostCardModel } from './types';
import { getDiagnosticsSnapshot, resetDiagnosticsForTests, setDiagnosticsLogSink } from './diagnostics';
import { DEFAULT_RELAYS, RELAYS_KEY } from '../../src/lib/relays';

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
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
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
    __resetResharesForTests();
    __resetPulledPostsForTests();
    __resetDeviceKeypairForTests();
    __setDrainRowDelayMsForTests(0);
    AsyncStorageMock.__clear();
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

  test('startTransport connects to the default relays when nothing is customized', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    expect(hybrid!.nostr.relayUrls).toEqual(DEFAULT_RELAYS);
    expect(FakeSocket.instances.map((s) => s.url)).toEqual(DEFAULT_RELAYS);
  });

  test('startTransport uses a persisted custom relay list for the World uplink', async () => {
    AsyncStorageMock.__setRaw(RELAYS_KEY, JSON.stringify(['wss://custom.relay']));
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    // The Nostr client itself was built with the custom list, so publish /
    // WorldSync traffic goes to the custom relay, not the defaults.
    expect(hybrid!.nostr.relayUrls).toEqual(['wss://custom.relay']);
    expect(FakeSocket.instances.map((s) => s.url)).toEqual(['wss://custom.relay']);
  });

  test('startTransport prunes expired posts at startup', async () => {
    const store = getStore();
    const expired = makeSignedEvent(); // created_at 1_700_000_000: long expired
    const fresh = { ...makeSignedEvent(), id: new Uint8Array(32).fill(8), created_at: Math.floor(Date.now() / 1000) };
    await store.saveEvent(expired);
    await store.saveEvent(fresh);
    expect(await store.getEvent('07'.repeat(32))).not.toBeNull();
    await startTransport();
    expect(await store.getEvent('07'.repeat(32))).toBeNull();
    expect(await store.getEvent('08'.repeat(32))).not.toBeNull();
    await expect(pruneExpiredStore()).resolves.toBeUndefined();
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
    // The relay pool watchdog (15 s, v0.1.31) is the only interval at
    // startup: the periodic sync timer (60 s) must not start offline.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 60_000);
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

  test('a relay win does NOT mark the post World-confirmed at publish time', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const event = makeSignedEvent();
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'relay',
      status: 'relayed',
      blePeers: 0,
      relays: ['wss://test.relay'],
      relayTried: true,
      relayDetail: null,
    });
    await publishViaTransport(event);
    // Rank 5: a relay OK alone is not World. A relay can OK and then
    // drop the event before any peer fetches it; confirmation comes
    // only from a relay observation (query hit or subscription replay).
    expect(await getStore().isWorldConfirmed(toHex(event.id))).toBe(false);
  });

  test('a relay observation confirms a post a relay win left unconfirmed', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const event = makeSignedEvent();
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'relay',
      status: 'relayed',
      blePeers: 0,
      relays: ['wss://test.relay'],
      relayTried: true,
      relayDetail: null,
    });
    await publishViaTransport(event);
    expect(await getStore().isWorldConfirmed(toHex(event.id))).toBe(false);
    // The WorldSync query round trip (or a subscription replay)
    // returns the post from a relay: that observation confirms it.
    hybrid!.ingress(event, 'nostr');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await getStore().isWorldConfirmed(toHex(event.id))).toBe(true);
  });

  test('drainPostOutbox sends queued posts over BLE oldest first and marks them ble-sent', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const older = { ...makeSignedEvent(), id: new Uint8Array(32).fill(21), created_at: Math.floor(Date.now() / 1000) - 600 };
    const newer = { ...makeSignedEvent(), id: new Uint8Array(32).fill(22), created_at: Math.floor(Date.now() / 1000) };
    for (const e of [older, newer]) {
      await store.saveEvent(e);
      await store.enqueuePostOutbox(toHex(e.id), e.created_at);
    }
    const sentIds: string[] = [];
    jest.spyOn(hybrid!, 'sendOverMesh').mockImplementation(async (event) => {
      sentIds.push(toHex(event.id));
      return 1;
    });
    __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
    const sent = await drainPostOutbox();
    expect(sent).toBe(2);
    expect(sentIds).toEqual([toHex(older.id), toHex(newer.id)]);
    const statuses = await store.listPostOutboxStatuses([toHex(older.id), toHex(newer.id)]);
    expect(statuses.get(toHex(older.id))).toBe('ble-sent');
    expect(statuses.get(toHex(newer.id))).toBe('ble-sent');
    __setBlePortForTests(null);
  });

  test('outbound post lines carry kind and the signed sequence number', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const event = { ...makeSignedEvent(), tags: [['seq', '9']] };
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'relay',
      status: 'relayed',
      blePeers: 0,
      relays: ['wss://test.relay'],
      relayTried: true,
      relayDetail: null,
    });
    await publishViaTransport(event);
    const lines = getDiagnosticsSnapshot().messages;
    const line = lines.find((m) => m.direction === 'outbound' && m.kind === 'post');
    expect(line).toBeDefined();
    expect(line!.sequence).toBe(9);
    expect(line!.finalStatus).toBe('relayed');
  });

  test('drainPostOutbox logs one message line per drained row', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const older = { ...makeSignedEvent(), id: new Uint8Array(32).fill(31), created_at: Math.floor(Date.now() / 1000) - 600, tags: [['seq', '4']] };
    const newer = { ...makeSignedEvent(), id: new Uint8Array(32).fill(32), created_at: Math.floor(Date.now() / 1000) };
    for (const e of [older, newer]) {
      await store.saveEvent(e);
      await store.enqueuePostOutbox(toHex(e.id), e.created_at);
    }
    jest.spyOn(hybrid!, 'sendOverMesh').mockResolvedValue(1);
    __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
    expect(await drainPostOutbox()).toBe(2);
    const lines = getDiagnosticsSnapshot().messages.filter(
      (m) => m.direction === 'outbound' && m.kind === 'post' && m.finalStatus === 'handed to radio over BLE',
    );
    expect(lines).toHaveLength(2);
    expect(lines.some((m) => m.sequence === 4)).toBe(true);
    expect(lines.every((m) => m.attempts[0]?.detail === 'drain ble sent to 1 peers')).toBe(true);
    __setBlePortForTests(null);
  });

  test('drainPostOutbox keeps a radio-handoff row queued for later triggers', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const event = { ...makeSignedEvent(), id: new Uint8Array(32).fill(41), created_at: Math.floor(Date.now() / 1000) - 600, tags: [['seq', '7']] };
    await store.saveEvent(event);
    await store.enqueuePostOutbox(toHex(event.id), event.created_at);
    // A BLE drain send is a radio handoff with no receipt signal: it
    // must NOT remove the row, or a send lost to a notify race has no
    // later trigger and no WorldSync re-push. The row stays until a
    // relay observation confirms it.
    jest.spyOn(hybrid!, 'sendOverMesh').mockResolvedValue(1);
    __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
    expect(await drainPostOutbox()).toBe(1);
    const rows = await store.listPostOutbox();
    expect(rows.map((r) => r.eventId)).toContain(toHex(event.id));
    expect(rows.find((r) => r.eventId === toHex(event.id))!.status).toBe('ble-sent');
    // A later trigger to the SAME peer does not re-send the row: the
    // v0.1.30 drain handed the same rows to the radio 3-4 times
    // (v0.1.31 handoff memory, 120 s window). The row stays queued
    // for a NEW peer or for the window to lapse.
    expect(await drainPostOutbox()).toBe(0);
    __setBlePortForTests({ connectedPeerIds: () => ['peerY'] } as never);
    expect(await drainPostOutbox()).toBe(1);
    __setBlePortForTests(null);
  });

  test('inbound stars log a message line instead of returning silently', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const star = { ...makeSignedEvent(), kind: 4, tags: [['e', 'c'.repeat(64)]] };
    hybrid!.ingress(star as never, 'nostr');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const lines = getDiagnosticsSnapshot().messages;
    expect(lines.some((m) => m.direction === 'inbound' && m.kind === 'star' && m.finalStatus === 'received')).toBe(true);
  });

  test('inbound reshares log a message line on success', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const crypto = new NobleCrypto();
    const other = crypto.generateKeypair();
    const postId = 'd'.repeat(64);
    const author = 'a'.repeat(64);
    const reshare = createReshare({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      originalPostId: fromHex(postId),
      originalAuthorPubkey: fromHex(author),
    });
    hybrid!.ingress(reshare, 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const lines = getDiagnosticsSnapshot().messages;
    expect(lines.some((m) => m.direction === 'inbound' && m.kind === 'reshare' && m.finalStatus === 'received')).toBe(true);
  });

  test('drainPostOutbox sends nothing when no live queued row exists', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const confirmed = { ...makeSignedEvent(), id: new Uint8Array(32).fill(23), created_at: Math.floor(Date.now() / 1000) };
    await store.saveEvent(confirmed);
    await store.enqueuePostOutbox(toHex(confirmed.id), confirmed.created_at);
    await store.markWorldConfirmed(toHex(confirmed.id));
    // A row with no event row is invisible to the drain list, so it
    // must not cause a send either.
    const ghost = { ...makeSignedEvent(), id: new Uint8Array(32).fill(24), created_at: Math.floor(Date.now() / 1000) };
    await store.enqueuePostOutbox(toHex(ghost.id), ghost.created_at);
    const sendSpy = jest.spyOn(hybrid!, 'sendOverMesh').mockResolvedValue(1);
    __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
    expect(await drainPostOutbox()).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await store.listPostOutbox()).toHaveLength(0);
    __setBlePortForTests(null);
  });

  test('drainPostOutbox paces rows: the second row waits for the inter-row gap', async () => {
    __setDrainRowDelayMsForTests(50);
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const older = { ...makeSignedEvent(), id: new Uint8Array(32).fill(61), created_at: Math.floor(Date.now() / 1000) - 600 };
    const newer = { ...makeSignedEvent(), id: new Uint8Array(32).fill(62), created_at: Math.floor(Date.now() / 1000) };
    for (const e of [older, newer]) {
      await store.saveEvent(e);
      await store.enqueuePostOutbox(toHex(e.id), e.created_at);
    }
    const sentIds: string[] = [];
    jest.spyOn(hybrid!, 'sendOverMesh').mockImplementation(async (event) => {
      sentIds.push(toHex(event.id));
      return 1;
    });
    __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
    const draining = drainPostOutbox();
    // 49 ms in, the first row has sent and the second is still parked
    // on the pacing timer: the v0.1.30 burst sent 7 rows in 130 ms and
    // lost every frame on the wire. At 50 ms the second row goes out.
    await jest.advanceTimersByTimeAsync(49);
    expect(sentIds).toEqual([toHex(older.id)]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await draining).toBe(2);
    expect(sentIds).toEqual([toHex(older.id), toHex(newer.id)]);
    __setBlePortForTests(null);
  });

  test('relay pool watchdog forces a reconnect when the pool is dead with no ladder running', async () => {
    const serviceLines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      if (kind === 'service') serviceLines.push(detail);
    });
    try {
      await startTransport();
      const hybrid = __getHybridForTests();
      expect(hybrid).not.toBeNull();
      const before = FakeSocket.instances.length;
      expect(before).toBeGreaterThan(0);
      // Kill the pool with no trigger: stop() clears the ladder and
      // closes the sockets, the state the v0.1.30 window sat in for
      // 3 minutes with no log line and no recovery.
      await hybrid!.nostr.stop();
      expect(hybrid!.nostr.openRelayCount()).toBe(0);
      expect(hybrid!.nostr.pendingReconnectCount()).toBe(0);
      // The watchdog ticks every 15 s but only forces an attempt when
      // no connect was attempted for 60 s (the reconnect cap), so the
      // first three ticks stay quiet and the fourth fires.
      await jest.advanceTimersByTimeAsync(45_000);
      expect(FakeSocket.instances.length).toBe(before);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(FakeSocket.instances.length).toBeGreaterThan(before);
      expect(serviceLines.some((l) => l.startsWith('relay pool watchdog:'))).toBe(true);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('going offline does not stop the relay pool: the reconnect ladder stays armed', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;
    listener({ isConnected: true, isInternetReachable: true });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const before = FakeSocket.instances.length;
    expect(before).toBeGreaterThan(0);
    // Offline now: the old code called nostr.stop() here, which
    // cancelled the reconnect ladder and left the pool dead until the
    // next online event (v0.1.30: 3 minutes of silence). The pool must
    // stay up: a dead network fails the socket attempt itself, and the
    // ladder backs off to its cap.
    listener({ isConnected: false, isInternetReachable: false });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(FakeSocket.instances.length).toBe(before);
    expect(FakeSocket.instances.every((s) => s.readyState !== 3)).toBe(true);
  });

  test('revalidateBleRadio picks up a grant made while the app runs', async () => {
    RN.PermissionsAndroid.check.mockReset();
    RN.PermissionsAndroid.check.mockResolvedValue(false);
    await startTransport();
    expect(getBleRadioState()).toBe('permission-blocked');
    RN.PermissionsAndroid.check.mockResolvedValue(true);
    await revalidateBleRadio();
    expect(getBleRadioState()).toBe('on');
    RN.PermissionsAndroid.check.mockResolvedValue(true);
  });

  test('publishViaTransport marks a queued post unsent in the outbox', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const event = makeSignedEvent();
    const store = getStore();
    await store.saveEvent(event);
    await store.enqueuePostOutbox(toHex(event.id), event.created_at);
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'none',
      status: 'queued',
      blePeers: 0,
      relays: [],
      relayTried: false,
      relayDetail: 'no open relay socket',
    });
    await publishViaTransport(event);
    const statuses = await store.listPostOutboxStatuses([toHex(event.id)]);
    expect(statuses.get(toHex(event.id))).toBe('unsent');
  });

  test('a relay skip for network not validated logs the last NetInfo state words', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    // Drive the NetInfo listener with a stuck-validation state: not
    // connected, reachability still unknown, on wifi.
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean | null;
      type: string;
    }) => void;
    listener({ isConnected: false, isInternetReachable: null, type: 'wifi' });
    const event = makeSignedEvent();
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'none',
      status: 'queued',
      blePeers: 0,
      relays: [],
      relayTried: false,
      relayDetail: 'network not validated',
    });
    await publishViaTransport(event);
    const messages = getDiagnosticsSnapshot().messages;
    const outbound = messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    const relayAttempt = outbound[0].attempts.find((a) => a.transport === 'relay');
    expect(relayAttempt?.outcome).toBe('skipped');
    expect(relayAttempt?.detail).toBe(
      'network not validated (connected=false reachable=null type=wifi)',
    );
  });

  test('a mesh publish records handed to radio, never delivered, in diagnostics', async () => {
    resetDiagnosticsForTests();
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const event = makeSignedEvent();
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'mesh',
      status: 'sent',
      blePeers: 2,
      relays: [],
      relayTried: true,
      relayDetail: 'no relay OK within 5000ms',
    });
    await publishViaTransport(event);
    const messages = getDiagnosticsSnapshot().messages;
    const outbound = messages.filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].finalStatus).toBe('handed to radio over BLE');
    expect(outbound[0].finalStatus).not.toMatch(/deliver/i);
    const bleAttempt = outbound[0].attempts.find((a) => a.transport === 'ble');
    expect(bleAttempt?.detail).toMatch(/handed to radio/);
    expect(bleAttempt?.detail).toMatch(/no peer receipt signal/);
  });

  test('runWorldSyncPass is a no-op while offline', async () => {
    await startTransport();
    // Fake sockets never open, so the transport is offline: one
    // foreground pass must resolve without throwing and schedule
    // nothing.
    await expect(runWorldSyncPass()).resolves.toBeUndefined();
  });

  test('an inbound burst coalesces to a single feed notify', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    let count = 0;
    const unsub = subscribeFeed(() => {
      count++;
    });
    for (let i = 0; i < 3; i++) {
      const event = makeSignedEvent();
      event.id = new Uint8Array(32).fill(10 + i);
      hybrid!.ingress(event, 'nostr');
    }
    // Let the async handleIncoming runs reach the coalescing timer.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(0);
    jest.advanceTimersByTime(250);
    expect(count).toBe(1);
    unsub();
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
    // Two intervals total: the relay pool watchdog (15 s, started at
    // launch) and the periodic sync timer (60 s, started once here).
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy.mock.calls.filter((c) => c[1] === 60_000)).toHaveLength(1);
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
    // restart Nostr, not just the sync timer, otherwise the silent
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
    // Since v0.1.32 the online transition re-attempts dead relays via
    // reconnectNow (clears any pending backoff timer and connects now),
    // not startIfNeeded (which skipped every relay with a timer
    // pending: the v0.1.31 lag, validation 08:31:53, pool open only
    // 08:32:10). The pool is already started, so start() would no-op.
    const nostrReconnectNowSpy = jest.spyOn(hybrid!.nostr, 'reconnectNow');
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: NetState) => void;
    // Listener fires offline first (reachability still unknown).
    listener({ isConnected: true, isInternetReachable: false });
    // Then the initial fetch resolves online.
    resolveFetch!({ isConnected: true, isInternetReachable: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(nostrReconnectNowSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test('duplicate online events start Nostr only once', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    // Since v0.1.32 the online transition re-attempts dead relays via
    // reconnectNow, not startIfNeeded or a bare start().
    const nostrReconnectNowSpy = jest.spyOn(hybrid!.nostr, 'reconnectNow');
    const listener = netInfoMock.addEventListener.mock.calls[0][0] as (s: {
      isConnected: boolean;
      isInternetReachable: boolean;
    }) => void;
    listener({ isConnected: true, isInternetReachable: true });
    listener({ isConnected: true, isInternetReachable: true }); // duplicate
    expect(nostrReconnectNowSpy).toHaveBeenCalledTimes(1);
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
    // Must not throw: app launches in offline-only mode.
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

  test('inbound post with failing storage is dropped without an unhandled rejection', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const spy = jest.spyOn(store, 'saveEvent').mockRejectedValue(new Error('disk full'));
    const event = makeSignedEvent();
    // ingress is void-called by the real wiring; a rejection here would
    // previously escape unhandled. It must resolve cleanly now. The
    // timer advance drains the bounded save retry loop.
    hybrid!.ingress(event, 'ble');
    await jest.advanceTimersByTimeAsync(1000);
    expect(await store.getEvent('07'.repeat(32))).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
    // The handler survives the failure: a later post still stores.
    const later = makeSignedEvent();
    later.id = new Uint8Array(32).fill(9);
    hybrid!.ingress(later, 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await store.getEvent('09'.repeat(32))).not.toBeNull();
  });

  test('inbound post with transient storage failure stores after retry', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    resetDiagnosticsForTests();
    const store = getStore();
    const spy = jest
      .spyOn(store, 'saveEvent')
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockRejectedValueOnce(new Error('database is locked'));
    const event = makeSignedEvent();
    hybrid!.ingress(event, 'ble');
    await jest.advanceTimersByTimeAsync(1000);
    expect(await store.getEvent('07'.repeat(32))).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
    const messages = getDiagnosticsSnapshot().messages;
    expect(
      messages.some((m) =>
        m.attempts.some((a) => (a.detail ?? '').includes('store save failed')),
      ),
    ).toBe(false);
    spy.mockRestore();
  });

  test('inbound post with permanent storage failure logs the reason code', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    resetDiagnosticsForTests();
    const store = getStore();
    const spy = jest.spyOn(store, 'saveEvent').mockRejectedValue(new Error('database is locked'));
    const event = makeSignedEvent();
    hybrid!.ingress(event, 'ble');
    await jest.advanceTimersByTimeAsync(1000);
    expect(await store.getEvent('07'.repeat(32))).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
    const messages = getDiagnosticsSnapshot().messages;
    expect(
      messages.some(
        (m) =>
          m.finalStatus === 'receive failed' &&
          m.attempts.some((a) => a.detail === 'store save failed locked'),
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  test('a failed inbound save forgets the seen mark so a redelivery can land', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    __resetFailedInboundForTests();
    resetDiagnosticsForTests();
    const store = getStore();
    const spy = jest.spyOn(store, 'saveEvent').mockRejectedValue(new Error('store boom'));
    try {
      const event = makeSignedEvent();
      expect(hybrid!.ingress(event, 'nostr')).toBe(true);
      // Let the in-process retries (100 ms + 300 ms) and the
      // best-effort relay re-query run to completion.
      await jest.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(await store.getEvent(toHex(event.id))).toBeNull();
      expect(spy).toHaveBeenCalledTimes(3);
      const messages = getDiagnosticsSnapshot().messages;
      expect(
        messages.some(
          (m) =>
            m.direction === 'inbound' &&
            m.finalStatus === 'receive failed' &&
            m.attempts.some((a) => (a.detail ?? '').includes('store save failed')),
        ),
      ).toBe(true);
      // The recovery forgot the seen mark: the same id passes
      // ingress again instead of being dropped as a duplicate.
      expect(hybrid!.ingress(event, 'nostr')).toBe(true);
      await jest.advanceTimersByTimeAsync(1000);
    } finally {
      spy.mockRestore();
    }
  });

  test('inbound receipts count views once via the counting path', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const postId = '07'.repeat(32);
    const makeReceipt = (seed: number) => ({
      id: new Uint8Array(32).fill(seed),
      pubkey: new Uint8Array(32).fill(1),
      created_at: 1_700_000_000,
      kind: 2,
      geohash: 'ezs42',
      tags: [['e', postId]],
      content: '',
      sig: new Uint8Array(64).fill(3),
    });
    hybrid!.ingress(makeReceipt(21) as never, 'nostr');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await store.countViews(postId)).toBe(1);
    // Same viewer, same post, same day, different event id: still one view.
    hybrid!.ingress(makeReceipt(22) as never, 'nostr');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await store.countViews(postId)).toBe(1);
  });

  test('kind-5 ingress counts, persists, and a pending reshare pulls its original post', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();

    const crypto = new NobleCrypto();
    const other = crypto.generateKeypair();
    const postId = 'c'.repeat(64);
    const author = 'a'.repeat(64);
    const reshare = createReshare({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      originalPostId: fromHex(postId),
      originalAuthorPubkey: fromHex(author),
    });

    // The post is unknown, so the reshare sits pending and pull-on-demand
    // asks the relays for the original post by id.
    const querySpy = jest.spyOn(hybrid!.nostr, 'queryByIds');
    hybrid!.ingress(reshare, 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(querySpy).toHaveBeenCalledWith([postId]);
    expect(reshareViewFor(postId).reshares).toBe(0);

    // The original post arrives: the pending reshare applies, no re-pull.
    const postEvent = makeSignedEvent();
    postEvent.id = fromHex(postId);
    postEvent.kind = 1;
    hybrid!.ingress(postEvent, 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(reshareViewFor(postId).reshares).toBe(1);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Persisted for rehydration, not in the kind-1 feed table.
    const stored = await getStore().listReshareEvents();
    expect(stored).toHaveLength(1);
    expect(await getStore().getEvent(postId)).not.toBeNull();
  });

  test('an offline pull does not block retry: pulled is marked only on query success', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const crypto = new NobleCrypto();
    const other = crypto.generateKeypair();
    const postId = 'e'.repeat(64);
    const author = 'a'.repeat(64);
    const mkReshare = (createdAt: number) =>
      createReshare({
        crypto,
        secretKey: other.secretKey,
        pubkey: other.publicKey,
        geohash5: 'tdr1v',
        originalPostId: fromHex(postId),
        originalAuthorPubkey: fromHex(author),
        createdAt,
      });
    const querySpy = jest
      .spyOn(hybrid!.nostr, 'queryByIds')
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    hybrid!.ingress(mkReshare(1_700_000_001), 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(querySpy).toHaveBeenCalledTimes(1);
    // A second reshare for the same still-unknown post retries the pull:
    // the first, offline pull did not mark it pulled for the launch.
    hybrid!.ingress(mkReshare(1_700_000_002), 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(querySpy).toHaveBeenCalledTimes(2);
    // And now that a query succeeded, a third reshare does not re-pull.
    hybrid!.ingress(mkReshare(1_700_000_003), 'ble');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  test('own reshare published via publishViaTransport echoes locally as a duplicate, not a double count', async () => {
    await startTransport();
    const postId = 'd'.repeat(64);
    markResharePostKnown(postId);
    // The toggle requires a stored kind-1 post; seed it (the point of
    // this test is the publish echo dedup, not toggle validation).
    await getStore().saveEvent({
      id: fromHex(postId),
      pubkey: fromHex('a'.repeat(64)),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      geohash: 'tdr1v',
      tags: [],
      content: 'seed post',
      sig: new Uint8Array(64),
    });
    const card: PostCardModel = {
      eventId: postId,
      createdAtMs: Date.now(),
      authorLabel: 'author',
      body: 'test post',
      geohash: 'tdr1v',
      views: 0,
      score: 0,
      worldConfirmed: false,
      authorPubkeyHex: 'a'.repeat(64),
      reshares: 0,
      resharedByMe: false,
      stars: 0,
      starLabel: '',
      starredByMe: false,
    };
    // Real publish path (no stub): no BLE peers, no open relays, but the
    // local echo flows through ingress and must not double count.
    await toggleReshare(card);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(reshareViewFor(postId).reshares).toBe(1);
    const stored = await getStore().listReshareEvents();
    expect(stored).toHaveLength(1);
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
    // No native BLE stack in jest: advertise fails, and the scan fails
    // too. Since v0.1.31 that no longer tears the radio down to
    // 'unavailable': bring-up resolves 'on' (scanning, advertising up
    // or retrying), the advertise retry and the scan retry are armed,
    // and the live advertise/scan truth is in diagnostics, not the
    // state. The point is the check-first path ran without wedging
    // the transport.
    expect(getBleRadioState()).toBe('on');
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

  test('blePeerIdsForPublish returns connected peers, with no readiness probe', () => {
    expect(blePeerIdsForPublish({ connectedPeerIds: () => ['c1', 'c2'] } as never)).toEqual(['c1', 'c2']);
    expect(blePeerIdsForPublish({ connectedPeerIds: () => [] } as never)).toEqual([]);
    expect(blePeerIdsForPublish(null)).toEqual([]);
    expect(blePeerIdsForPublish(undefined)).toEqual([]);
  });

  test('resolveRelayState truth table', () => {
    expect(resolveRelayState(true, 'on')).toBe('online');
    expect(resolveRelayState(true, 'permission-blocked')).toBe('online');
    expect(resolveRelayState(false, 'on')).toBe('mesh');
    expect(resolveRelayState(false, 'starting')).toBe('mesh');
    expect(resolveRelayState(false, 'permission-blocked')).toBe('offline');
    expect(resolveRelayState(false, 'unavailable')).toBe('offline');
    // A failed start never reports mesh, even with a starting radio.
    expect(resolveRelayState(false, 'starting', true)).toBe('offline');
    expect(resolveRelayState(false, 'on', true)).toBe('offline');
    expect(resolveRelayState(true, 'on', true)).toBe('offline');
  });

  test('getMeshStatus after stopTransport reports 0 peers and offline', () => {
    stopTransport();
    const s = getMeshStatus();
    expect(s.peersNearby).toBe(0);
    expect(s.relayState).toBe('offline');
  });
});

describe('mesh-scan fix: scan failure keeps advertising', () => {
  // This describe sits outside the file's 'transport manager' describe,
  // so it needs its own lifecycle: fake timers for the scan retry
  // backoff, and stopTransport cleanup so no retry timer outlives a test.
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
    __resetResharesForTests();
    __resetPulledPostsForTests();
    __resetDeviceKeypairForTests();
    __setDrainRowDelayMsForTests(0);
    AsyncStorageMock.__clear();
    jest.useFakeTimers();
  });

  afterEach(async () => {
    jest.clearAllTimers();
    await stopTransport();
    jest.useRealTimers();
    (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    __setBlePortForTests(null);
  });

  function grantPermissions(): void {
    RN.PermissionsAndroid.check.mockReset();
    RN.PermissionsAndroid.check.mockResolvedValue(true);
    const granted = (RN.PermissionsAndroid as unknown as { RESULTS?: { GRANTED?: unknown } }).RESULTS?.GRANTED ?? 'granted';
    RN.PermissionsAndroid.request.mockReset();
    RN.PermissionsAndroid.request.mockResolvedValue(granted);
  }

  test('scan failure does not stop advertising and retries with backoff', async () => {
    grantPermissions();
    await startTransport();
    let scanAttempt = 0;
    const port = {
      advertise: jest.fn(async () => {}),
      stopAdvertise: jest.fn(async () => {}),
      scan: jest.fn(async () => {
        scanAttempt++;
        if (scanAttempt === 1) throw new Error('ble: central scan timed out after 10000ms');
        return () => {};
      }),
    };
    __setBlePortForTests(port as never);
    try {
      expect(await retryBleRadio()).toBe(true);
      expect(getBleRadioState()).toBe('on');
      expect(port.advertise).toHaveBeenCalledTimes(1);
      // stopAdvertise ran once for retryBleRadio's pre-bring-up
      // teardown, not again for the scan failure.
      expect(port.stopAdvertise).toHaveBeenCalledTimes(1);
      expect(port.scan).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(port.scan).toHaveBeenCalledTimes(2);
    } finally {
      __setBlePortForTests(null);
    }
  });

  test('concurrent bring-ups share one advertise call', async () => {
    grantPermissions();
    await startTransport();
    let releaseAdvertise!: () => void;
    const advertiseGate = new Promise<void>((r) => {
      releaseAdvertise = r;
    });
    const port = {
      advertise: jest.fn(async () => {
        await advertiseGate;
      }),
      stopAdvertise: jest.fn(async () => {}),
      scan: jest.fn(async () => () => {}),
    };
    __setBlePortForTests(port as never);
    try {
      const p1 = retryBleRadio();
      const p2 = retryBleRadio();
      releaseAdvertise();
      await expect(p1).resolves.toBe(true);
      await expect(p2).resolves.toBe(true);
      expect(port.advertise).toHaveBeenCalledTimes(1);
    } finally {
      __setBlePortForTests(null);
    }
  });

  test('advertise failure schedules a bounded retry instead of tearing the radio down', async () => {
    grantPermissions();
    await startTransport();
    let advertiseAttempts = 0;
    const port = {
      advertise: jest.fn(async () => {
        advertiseAttempts++;
        if (advertiseAttempts === 1) {
          throw new Error('ble: advertise failed: ble: peripheral ready failed: Not support bluetoothLeAdvertiser');
        }
      }),
      stopAdvertise: jest.fn(async () => {}),
      scan: jest.fn(async () => () => {}),
    };
    __setBlePortForTests(port as never);
    try {
      // The first advertise fails at startup (the v0.1.30 failure on
      // both phones), but bring-up still resolves: the phone can scan
      // and central-connect, and the retry re-attempts advertise.
      expect(await retryBleRadio()).toBe(true);
      expect(getBleRadioState()).toBe('on');
      expect(port.advertise).toHaveBeenCalledTimes(1);
      // The retry fires after 2 s with the same peer id and succeeds.
      await jest.advanceTimersByTimeAsync(2000);
      expect(port.advertise).toHaveBeenCalledTimes(2);
      expect(getBleRadioState()).toBe('on');
      // No further retries are pending once advertise recovered.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(port.advertise).toHaveBeenCalledTimes(2);
    } finally {
      __setBlePortForTests(null);
    }
  });

describe('transport revert (v0.1.35): no balancer decision layer in the publish path', () => {
  const serviceLines: string[] = [];

  beforeEach(() => {
    serviceLines.length = 0;
    setDiagnosticsLogSink((kind, detail) => {
      if (kind === 'service') serviceLines.push(detail);
    });
    __resetTransportForTests();
  });

  afterEach(() => {
    setDiagnosticsLogSink(null);
    __resetTransportForTests();
  });

  test('a relay win removes the outbox row (v0.1.26 behavior restored)', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const event = { ...makeSignedEvent(), id: new Uint8Array(32).fill(51), created_at: Math.floor(Date.now() / 1000) - 600, tags: [['seq', '12']] };
    await store.saveEvent(event);
    await store.enqueuePostOutbox(toHex(event.id), event.created_at);
    jest.spyOn(hybrid!, 'publish').mockResolvedValue({
      transport: 'relay',
      status: 'relayed',
      blePeers: 0,
      relays: ['wss://test.relay'],
      relayTried: true,
      relayDetail: null,
    });
    await publishViaTransport(event);
    // The row is removed on relay win: the relay-win Bluetooth
    // broadcast (inside the router) already seeded connected peers,
    // so the outbox has no late-peer copy to hold.
    const rows = await store.listPostOutbox();
    expect(rows.map((r) => r.eventId)).not.toContain(toHex(event.id));
  });

  test('a publish passes every connected peer to the router, unfiltered', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const peerA = 'aa'.repeat(32);
    const peerB = 'bb'.repeat(32);
    const captured: string[][] = [];
    jest.spyOn(hybrid!, 'publish').mockImplementation(async (_event, blePeers) => {
      captured.push([...(blePeers ?? [])]);
      return {
        transport: 'none',
        status: 'queued',
        blePeers: 0,
        relays: [],
        relayTried: false,
        relayDetail: 'no open relay socket',
      };
    });
    try {
      __setBlePortForTests({ connectedPeerIds: () => [peerA, peerB] } as never);
      await publishViaTransport(makeSignedEvent());
      // No health gating, no ready gate, no backoff hold-out: the
      // router gets both connected peers.
      expect(captured).toEqual([[peerA, peerB]]);
      expect(serviceLines.some((l) => l.startsWith('balancer route '))).toBe(false);
    } finally {
      __setBlePortForTests(null);
    }
  });

  test('a peer arriving drains the post outbox over BLE (mesh poll 0-to-N edge)', async () => {
    await startTransport();
    const hybrid = __getHybridForTests();
    expect(hybrid).not.toBeNull();
    const store = getStore();
    const event = { ...makeSignedEvent(), id: new Uint8Array(32).fill(61), created_at: Math.floor(Date.now() / 1000) - 600 };
    await store.saveEvent(event);
    await store.enqueuePostOutbox(toHex(event.id), event.created_at);
    const sentIds: string[] = [];
    jest.spyOn(hybrid!, 'sendOverMesh').mockImplementation(async (e) => {
      sentIds.push(toHex(e.id));
      return 1;
    });
    // No peers at first: the poll sees 0 peers, nothing drains.
    __setBlePortForTests({ connectedPeerIds: () => [] } as never);
    const unsub = subscribeMeshStatus(() => {});
    try {
      await jest.advanceTimersByTimeAsync(2100);
      expect(sentIds).toEqual([]);
      // A peer arrives: the 0-to-N edge drains the queued post.
      __setBlePortForTests({ connectedPeerIds: () => ['peerX'] } as never);
      await jest.advanceTimersByTimeAsync(2100);
      expect(sentIds).toEqual([toHex(event.id)]);
    } finally {
      unsub();
      __setBlePortForTests(null);
    }
  });
});
});
