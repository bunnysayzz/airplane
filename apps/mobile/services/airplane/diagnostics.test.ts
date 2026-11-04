// SPDX-License-Identifier: Apache-2.0
// Diagnostics collector tests: state transitions, the 30 second scan
// start window, peer upsert and resolve, and the message log cap.

import {
  getDiagnosticsSnapshot,
  recordAdvertiseFailure,
  recordAdvertiseStopped,
  recordAdvertiseSuccess,
  recordDedupDrop,
  recordFragmentsReceived,
  recordFragmentsSent,
  recordIncompleteFragmentSet,
  recordMessage,
  recordPacketReceived,
  recordPacketSent,
  recordPeerConnected,
  recordPeerDisconnected,
  recordPeerResolved,
  recordPeerSeen,
  recordScanFailure,
  recordScanSightings,
  recordScanStarted,
  recordScanStopped,
  recordConnectFailure,
  recordInboxEvent,
  recordServiceEvent,
  recordTransportFailure,
  recordUiEvent,
  recordUiNavigation,
  recordUpdateEvent,
  resetDiagnosticsForTests,
  setDiagnosticsAdapterState,
  setDiagnosticsLogSink,
  setDiagnosticsPermissions,
  subscribeDiagnostics,
  type DiagnosticsMessage,
} from './diagnostics';

function message(id: string): DiagnosticsMessage {
  return {
    id,
    sequence: null,
    sizeBytes: 100,
    direction: 'outbound',
    kind: 'post',
    attempts: [{ transport: 'relay', atMs: Date.now(), outcome: 'ok', detail: null }],
    finalStatus: 'relayed',
  };
}

describe('diagnostics collector', () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  test('starts empty: adapter unknown, advertising and scanning stopped', () => {
    const snap = getDiagnosticsSnapshot();
    expect(snap.adapterState).toBe('unknown');
    expect(snap.advertising.state).toBe('stopped');
    expect(snap.advertising.lastSuccessAtMs).toBeNull();
    expect(snap.advertising.advertisementLengthBytes).toBeNull();
    expect(snap.scanning.state).toBe('stopped');
    expect(snap.scanning.scanStartsLast30s).toBe(0);
    expect(snap.peers).toEqual([]);
    expect(snap.messages).toEqual([]);
    expect(snap.permissions).toBeNull();
    expect(snap.ttlDrops).toBeNull();
    expect(snap.relayForwards).toBeNull();
  });

  test('transport start failure writes one Diagnostics line', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    recordTransportFailure('start');
    expect(lines).toEqual(['transport start failed start']);
    setDiagnosticsLogSink(null);
  });

  test('message lines carry kind and sequence, and omit an empty attempts segment', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    recordMessage({
      ...message('msg-seq'),
      sequence: 12,
      kind: 'dm',
      sizeBytes: 312,
      direction: 'inbound',
      finalStatus: 'received',
      attempts: [{ transport: 'relay', atMs: Date.now(), outcome: 'ok', detail: null }],
    });
    recordMessage({
      ...message('msg-no-channel'),
      kind: 'dm',
      finalStatus: 'received',
      attempts: [],
    });
    expect(lines).toEqual([
      'message inbound dm seq=12 312B received relay:ok',
      'message outbound dm seq=none 100B received',
    ]);
    setDiagnosticsLogSink(null);
  });

  test('adapter state and advertise transitions are recorded', () => {
    setDiagnosticsAdapterState('on');
    recordAdvertiseSuccess(12);
    let snap = getDiagnosticsSnapshot();
    expect(snap.adapterState).toBe('on');
    expect(snap.advertising.state).toBe('started');
    expect(snap.advertising.advertisementLengthBytes).toBe(12);
    expect(snap.advertising.lastSuccessAtMs).not.toBeNull();
    expect(snap.advertising.lastFailure).toBeNull();

    recordAdvertiseFailure('peripheral role unavailable (native module missing)');
    snap = getDiagnosticsSnapshot();
    expect(snap.advertising.state).toBe('stopped');
    expect(snap.advertising.lastFailure).toBe('peripheral role unavailable (native module missing)');

    recordAdvertiseSuccess(12);
    recordAdvertiseStopped();
    expect(getDiagnosticsSnapshot().advertising.state).toBe('stopped');
  });

  test('a scan failure stops the scanning state instead of only logging', () => {
    recordScanStarted();
    expect(getDiagnosticsSnapshot().scanning.state).toBe('started');
    recordScanFailure('native scan died');
    const snap = getDiagnosticsSnapshot();
    expect(snap.scanning.state).toBe('stopped');
    expect(snap.scanning.lastFailure).toBe('native scan died');
  });

  test('scan start count prunes starts older than 30 seconds', () => {
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      for (let i = 0; i < 6; i++) {
        recordScanStarted();
      }
      expect(getDiagnosticsSnapshot().scanning.scanStartsLast30s).toBe(6);
      // 29 seconds later the window still holds all six starts.
      now += 29_000;
      expect(getDiagnosticsSnapshot().scanning.scanStartsLast30s).toBe(6);
      // Past 30 seconds, the window is empty and a new start counts as one.
      now += 2_000;
      expect(getDiagnosticsSnapshot().scanning.scanStartsLast30s).toBe(0);
      recordScanStarted();
      expect(getDiagnosticsSnapshot().scanning.scanStartsLast30s).toBe(1);
      recordScanStopped();
      expect(getDiagnosticsSnapshot().scanning.state).toBe('stopped');
    } finally {
      Date.now = realNow;
    }
  });

  test('notify visits subscribers from a snapshot, not the live set', async () => {
    const calls: string[] = [];
    let unsubSecond: (() => void) | null = null;
    subscribeDiagnostics(() => {
      calls.push('first');
      unsubSecond?.();
    });
    unsubSecond = subscribeDiagnostics(() => {
      calls.push('second');
    });
    setDiagnosticsAdapterState('on');
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The first subscriber unsubscribes the second mid-notify, but the
    // snapshot copy still visits it; live-set iteration would skip it.
    expect(calls).toEqual(['first', 'second']);
  });

  test('peer cap evicts a seen peer before a connected one and never exceeds 100', () => {
    for (let i = 0; i < 100; i++) {
      recordPeerSeen(`tag:${i.toString(16).padStart(16, '0')}`, -60, '0123456789abcdef');
    }
    recordPeerConnected('tag:0000000000000000', 128, true);
    recordPeerSeen('tag:ffffffffffffffff', -60, '0123456789abcdef');
    const snap = getDiagnosticsSnapshot();
    expect(snap.peers).toHaveLength(100);
    expect(snap.peers.some((p) => p.peerId === 'tag:0000000000000000')).toBe(true);
    expect(snap.peers.some((p) => p.peerId === 'tag:ffffffffffffffff')).toBe(true);
  });

  test('peer resolve carries over connection state the survivor lacks', () => {
    recordPeerSeen('tag:0102030405060708', -70, '0102030405060708');
    recordPeerConnected('tag:0102030405060708', 256, true);
    recordPeerSeen('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', -60, '0807060504030201');
    recordPeerResolved(
      'tag:0102030405060708',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const snap = getDiagnosticsSnapshot();
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0].gattState).toBe('connected');
    expect(snap.peers[0].mtu).toBe(256);
    expect(snap.peers[0].cccdSubscribed).toBe(true);
  });

  test('peer upsert keeps the newest sighting and survives a resolve', () => {
    recordPeerSeen('tag:0102030405060708', -70, '0102030405060708');
    recordPeerSeen('tag:0102030405060708', -55, '0102030405060708');
    let snap = getDiagnosticsSnapshot();
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0].rssi).toBe(-55);
    expect(snap.peers[0].advertisementHex).toBe('0102030405060708');
    expect(snap.peers[0].gattState).toBe('seen');

    recordFragmentsSent('tag:0102030405060708', 3);
    recordPacketSent('tag:0102030405060708');
    recordPeerResolved(
      'tag:0102030405060708',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    snap = getDiagnosticsSnapshot();
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0].peerId).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(snap.peers[0].frames.fragmentsSent).toBe(3);
    expect(snap.peers[0].frames.packetsSent).toBe(1);
    expect(snap.peers[0].advertisementHex).toBe('0102030405060708');

    recordPeerConnected(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      512,
      true,
    );
    snap = getDiagnosticsSnapshot();
    expect(snap.peers[0].gattState).toBe('connected');
    expect(snap.peers[0].mtu).toBe(512);
    expect(snap.peers[0].cccdSubscribed).toBe(true);

    recordPeerDisconnected(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(getDiagnosticsSnapshot().peers[0].gattState).toBe('disconnected');
  });

  test('frame counters accumulate per peer, including partial sets', () => {
    const peer = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    recordFragmentsReceived(peer, 2);
    recordIncompleteFragmentSet(peer);
    recordIncompleteFragmentSet(peer);
    recordPacketReceived(peer);
    recordFragmentsSent(peer, 1);
    recordPacketSent(peer);
    recordDedupDrop(peer);
    recordDedupDrop(null);
    const snap = getDiagnosticsSnapshot();
    expect(snap.peers).toHaveLength(1);
    expect(snap.peers[0].frames).toEqual({
      packetsSent: 1,
      packetsReceived: 1,
      fragmentsSent: 1,
      fragmentsReceived: 2,
      incompleteFragmentSets: 2,
      dedupDrops: 1,
    });
    expect(snap.dedupDrops).toBe(2);
  });

  test('message log appends newest first and caps at 50', () => {
    for (let i = 0; i < 55; i++) {
      recordMessage(message(`msg-${i}`));
    }
    const snap = getDiagnosticsSnapshot();
    expect(snap.messages).toHaveLength(50);
    expect(snap.messages[0].id).toBe('msg-54');
    expect(snap.messages[49].id).toBe('msg-5');
  });

  test('subscribers fire on record and stop after unsubscribe', () => {
    jest.useFakeTimers();
    try {
      const cb = jest.fn();
      const unsub = subscribeDiagnostics(cb);
      recordAdvertiseSuccess(12);
      expect(cb).not.toHaveBeenCalled();
      jest.advanceTimersByTime(250);
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      recordAdvertiseSuccess(12);
      jest.advanceTimersByTime(250);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('bursts coalesce into a single trailing notification', () => {
    jest.useFakeTimers();
    try {
      const cb = jest.fn();
      const unsub = subscribeDiagnostics(cb);
      recordAdvertiseSuccess(12);
      recordAdvertiseSuccess(12);
      recordAdvertiseSuccess(12);
      jest.advanceTimersByTime(249);
      expect(cb).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledTimes(1);
      recordAdvertiseSuccess(12);
      jest.advanceTimersByTime(250);
      expect(cb).toHaveBeenCalledTimes(2);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  test('permission report is stored and returned in the snapshot', () => {
    setDiagnosticsPermissions({
      scan: 'granted',
      advertise: 'denied',
      connect: 'granted',
      location: 'granted',
      locationServices: 'unavailable',
      batteryOptimisation: 'unavailable',
      autostart: 'unavailable',
    });
    const snap = getDiagnosticsSnapshot();
    expect(snap.permissions?.advertise).toBe('denied');
    expect(snap.permissions?.locationServices).toBe('unavailable');
  });
});

describe('scan sighting summary', () => {
  test('recordScanSightings logs a counts-only summary line', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind}:${detail}`));
    try {
      recordScanSightings(12, 3, 9, 'ffff:8x2,1234:2x1', 60000, 5, 1);
      expect(lines).toEqual([
        'scan:sightings window=60000ms total=12 mesh=3 nonmesh=9 unique=5 meshUnique=1 md=ffff:8x2,1234:2x1',
      ]);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });
});

describe('ui event logging', () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  function uiLines(): string[] {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    return lines;
  }

  test('logs action names only, with no snapshot change', () => {
    const lines = uiLines();
    try {
      recordUiEvent('tab:feed');
      expect(lines).toEqual(['ui tap tab:feed']);
      const snap = getDiagnosticsSnapshot();
      expect(snap.peers).toEqual([]);
      expect(snap.messages).toEqual([]);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('a full peer id target is truncated, never emitted whole', () => {
    const lines = uiLines();
    const fullId = 'ab'.repeat(32);
    try {
      recordUiEvent('post:open', fullId);
      expect(lines).toEqual(['ui tap post:open abababab...']);
      expect(lines.join('\n')).not.toContain(fullId);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('post text, coordinates, and pasted non-id text are dropped', () => {
    const lines = uiLines();
    try {
      recordUiEvent('post:star', 'hello secret post text');
      recordUiEvent('dm:open', '12.345678,-98.765432');
      recordUiEvent('dm:start-paste', 'not a key at all');
      expect(lines).toEqual(['ui tap post:star', 'ui tap dm:open', 'ui tap dm:start-paste']);
      const joined = lines.join('\n');
      expect(joined).not.toContain('secret');
      expect(joined).not.toContain('12.345678');
      expect(joined).not.toContain('not a key');
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('a mac target is aliased, never emitted raw', () => {
    const lines = uiLines();
    try {
      recordUiEvent('dm:open', 'mac:AA:BB:CC:DD:EE:FF');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^ui tap dm:open mac-peer-\d+$/);
      expect(lines.join('\n')).not.toContain('AA:BB');
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('an invalid action logs no payload at all', () => {
    const lines = uiLines();
    const fullId = 'ab'.repeat(32);
    try {
      recordUiEvent('tap!', fullId);
      expect(lines).toEqual(['ui tap invalid-action']);
      expect(lines.join('\n')).not.toContain(fullId);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('navigation lines carry direction and a static screen name', () => {
    const lines = uiLines();
    try {
      recordUiNavigation('forward', 'post');
      recordUiNavigation('back', 'feed');
      recordUiNavigation('forward', '/post/abc123def456');
      expect(lines).toEqual(['ui nav forward post', 'ui nav back feed', 'ui nav forward unknown-screen']);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });
});

describe('updater, inbox, and service event lines', () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  test('updater check, download, and install outcomes each log one line', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    try {
      recordUpdateEvent('check up-to-date 0.1.22');
      recordUpdateEvent('check available 0.1.23');
      recordUpdateEvent('check failed http-403');
      recordUpdateEvent('download started 0.1.23');
      recordUpdateEvent('download progress 50');
      recordUpdateEvent('verify ok 0.1.23');
      recordUpdateEvent('install intent fired 0.1.23');
      expect(lines).toEqual([
        'update check up-to-date 0.1.22',
        'update check available 0.1.23',
        'update check failed http-403',
        'update download started 0.1.23',
        'update download progress 50',
        'update verify ok 0.1.23',
        'update install intent fired 0.1.23',
      ]);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('inbox upload outcomes log without any id', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    try {
      recordInboxEvent('upload started');
      recordInboxEvent('upload truncated original=3000000');
      recordInboxEvent('upload sent');
      recordInboxEvent('upload failed upload failed: 413');
      expect(lines).toEqual([
        'inbox upload started',
        'inbox upload truncated original=3000000',
        'inbox upload sent',
        'inbox upload failed upload failed: 413',
      ]);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('connect failure codes never carry a raw BLE address', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    try {
      recordConnectFailure('auto-connect 63:B2:5A:AC:6F:81: ble: connect failed: Characteristic not found');
      expect(lines).toEqual([
        'peer connect failed auto-connect mac-peer: ble: connect failed: Characteristic not found',
      ]);
      expect(lines.join('\n')).not.toContain('63:B2:5A:AC:6F:81');
    } finally {
      setDiagnosticsLogSink(null);
    }
  });

  test('service failures log instead of vanishing', () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => {
      lines.push(`${kind} ${detail}`);
    });
    try {
      recordServiceEvent('dm start failed relay');
      recordServiceEvent('sync pass failed');
      expect(lines).toEqual([
        'service dm start failed relay',
        'service sync pass failed',
      ]);
    } finally {
      setDiagnosticsLogSink(null);
    }
  });
});
