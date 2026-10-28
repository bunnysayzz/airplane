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
  recordScanStarted,
  recordScanStopped,
  resetDiagnosticsForTests,
  setDiagnosticsAdapterState,
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
