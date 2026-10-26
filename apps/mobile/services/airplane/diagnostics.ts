// SPDX-License-Identifier: Apache-2.0
// Live diagnostics collector for the R2 diagnostics screen.
//
// This module holds facts, not estimates. Every field it reports comes
// from a hook at the site where the fact already exists (BLE advertise,
// scan, connect, send, receive in ble/gatt.ts; publish and ingress in
// transport.ts; permission checks in ble/permissions.ts). Anything the
// app cannot observe is reported as null with a plain reason, never as
// a fabricated value.
//
// Two fields are null by design, not by missing wiring:
// - ttlDrops: the app never re-floods a received mesh event, so no code
//   path drops on TTL. There is nothing to count.
// - relayForwards: same reason. A received event is stored and, when
//   online, uploaded to relays by WorldSync; it is never forwarded over
//   the mesh to another peer.
// Dedup drops are counted: BleTransport loop suppression and
// HybridTransport cross-transport dedup both report through hooks.
//
// No React Native import here: the collector is plain state so unit
// tests run in Node and the screen subscribes to it.

export type DiagnosticsAdapterState =
  | 'unknown'
  | 'starting'
  | 'on'
  | 'permission-blocked'
  | 'unavailable';

export type DiagnosticsGattState = 'seen' | 'connected' | 'disconnected';

export type DiagnosticsTransportKind = 'relay' | 'ble' | 'mesh';

export type DiagnosticsAttemptOutcome = 'ok' | 'failed' | 'queued';

export interface DiagnosticsPeerFrames {
  packetsSent: number;
  packetsReceived: number;
  fragmentsSent: number;
  fragmentsReceived: number;
  /** Incomplete fragment sets observed (a chunk arrived, no datagram completed). */
  incompleteFragmentSets: number;
  dedupDrops: number;
}

export interface DiagnosticsPeer {
  peerId: string;
  lastSeenAtMs: number | null;
  rssi: number | null;
  /** Hex of the 8-byte advertisement tag, when the peer was seen by scan. */
  advertisementHex: string | null;
  gattState: DiagnosticsGattState;
  mtu: number | null;
  /** True once we subscribed to the peer TX characteristic. Null when the
   * library does not report subscription state (peripheral-role peers). */
  cccdSubscribed: boolean | null;
  frames: DiagnosticsPeerFrames;
}

export interface DiagnosticsMessageAttempt {
  transport: DiagnosticsTransportKind;
  atMs: number;
  outcome: DiagnosticsAttemptOutcome;
  detail: string | null;
}

export interface DiagnosticsMessage {
  id: string;
  /** Per-conversation sender sequence. Null until the ordered router (R4) assigns one. */
  sequence: number | null;
  sizeBytes: number;
  direction: 'outbound' | 'inbound';
  attempts: DiagnosticsMessageAttempt[];
  finalStatus: string;
}

export type DiagnosticsPermissionState = 'granted' | 'denied' | 'unavailable';

export interface DiagnosticsPermissionReport {
  scan: DiagnosticsPermissionState;
  advertise: DiagnosticsPermissionState;
  connect: DiagnosticsPermissionState;
  location: DiagnosticsPermissionState;
  /** Location services on/off: no API for this is wired in the app. */
  locationServices: DiagnosticsPermissionState;
  /** Battery optimisation exemption: no API for this is wired in the app. */
  batteryOptimisation: DiagnosticsPermissionState;
  /** OEM autostart state: no API for this is wired in the app. */
  autostart: DiagnosticsPermissionState;
}

export interface DiagnosticsSnapshot {
  updatedAtMs: number;
  adapterState: DiagnosticsAdapterState;
  advertising: {
    state: 'started' | 'stopped';
    lastSuccessAtMs: number | null;
    lastFailure: string | null;
    advertisementLengthBytes: number | null;
  };
  scanning: {
    state: 'started' | 'stopped';
    lastFailure: string | null;
    /** Scan starts in the last 30 seconds (Android throttles past 5). */
    scanStartsLast30s: number;
  };
  peers: DiagnosticsPeer[];
  messages: DiagnosticsMessage[];
  permissions: DiagnosticsPermissionReport | null;
  dedupDrops: number;
  ttlDrops: number | null;
  ttlDropsReason: string;
  relayForwards: number | null;
  relayForwardsReason: string;
}

const SCAN_WINDOW_MS = 30_000;
const MAX_MESSAGES = 50;
const MAX_PEERS = 100;

const TTL_DROPS_REASON =
  'Not applicable: the app never re-floods a received mesh event, so no code path drops on TTL.';
const RELAY_FORWARDS_REASON =
  'Not applicable: received events are stored, not forwarded over the mesh to another peer.';

function emptyFrames(): DiagnosticsPeerFrames {
  return {
    packetsSent: 0,
    packetsReceived: 0,
    fragmentsSent: 0,
    fragmentsReceived: 0,
    incompleteFragmentSets: 0,
    dedupDrops: 0,
  };
}

function newPeer(peerId: string): DiagnosticsPeer {
  return {
    peerId,
    lastSeenAtMs: null,
    rssi: null,
    advertisementHex: null,
    gattState: 'seen',
    mtu: null,
    cccdSubscribed: null,
    frames: emptyFrames(),
  };
}

let adapterState: DiagnosticsAdapterState = 'unknown';
let advertisingState: 'started' | 'stopped' = 'stopped';
let advertisingLastSuccessAtMs: number | null = null;
let advertisingLastFailure: string | null = null;
let advertisingLengthBytes: number | null = null;
let scanningState: 'started' | 'stopped' = 'stopped';
let scanningLastFailure: string | null = null;
let scanStarts: number[] = [];
const peers = new Map<string, DiagnosticsPeer>();
const messages: DiagnosticsMessage[] = [];
let permissionReport: DiagnosticsPermissionReport | null = null;
let dedupDropTotal = 0;

const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // a broken subscriber must not break the collector
    }
  }
}

function ensurePeer(peerId: string): DiagnosticsPeer {
  let peer = peers.get(peerId);
  if (!peer) {
    peer = newPeer(peerId);
    peers.set(peerId, peer);
    if (peers.size > MAX_PEERS) {
      // Evict the stalest peer (null lastSeen sorts first).
      let stalest: string | null = null;
      let stalestAt = Number.POSITIVE_INFINITY;
      for (const [id, p] of peers) {
        const at = p.lastSeenAtMs ?? -1;
        if (at < stalestAt) {
          stalestAt = at;
          stalest = id;
        }
      }
      if (stalest !== null && stalest !== peerId) peers.delete(stalest);
    }
  }
  return peer;
}

function pruneScanStarts(nowMs: number): void {
  scanStarts = scanStarts.filter((t) => nowMs - t < SCAN_WINDOW_MS);
}

// --------------------------------------------------------------- adapter

export function setDiagnosticsAdapterState(state: DiagnosticsAdapterState): void {
  adapterState = state;
  notify();
}

// ------------------------------------------------------------ advertising

export function recordAdvertiseSuccess(advertisementLengthBytes: number): void {
  advertisingState = 'started';
  advertisingLastSuccessAtMs = Date.now();
  advertisingLastFailure = null;
  advertisingLengthBytes = advertisementLengthBytes;
  notify();
}

export function recordAdvertiseFailure(code: string): void {
  advertisingState = 'stopped';
  advertisingLastFailure = code;
  notify();
}

export function recordAdvertiseStopped(): void {
  advertisingState = 'stopped';
  notify();
}

// ---------------------------------------------------------------- scanning

export function recordScanStarted(): void {
  scanningState = 'started';
  scanStarts.push(Date.now());
  pruneScanStarts(Date.now());
  notify();
}

export function recordScanStopped(): void {
  scanningState = 'stopped';
  notify();
}

export function recordScanFailure(code: string): void {
  scanningLastFailure = code;
  notify();
}

// ------------------------------------------------------------------- peers

export function recordPeerSeen(peerId: string, rssi: number, advertisementHex: string): void {
  const peer = ensurePeer(peerId);
  peer.lastSeenAtMs = Date.now();
  peer.rssi = rssi;
  peer.advertisementHex = advertisementHex;
  if (peer.gattState !== 'connected') peer.gattState = 'seen';
  notify();
}

/** A provisional id (tag:/mac:) resolved to a full peer id. Merges the old entry. */
export function recordPeerResolved(oldKey: string, peerId: string): void {
  if (oldKey === peerId) return;
  const old = peers.get(oldKey);
  if (!old) return;
  const next = peers.get(peerId);
  if (next) {
    for (const k of Object.keys(old.frames) as (keyof DiagnosticsPeerFrames)[]) {
      next.frames[k] += old.frames[k];
    }
    if ((old.lastSeenAtMs ?? -1) > (next.lastSeenAtMs ?? -1)) next.lastSeenAtMs = old.lastSeenAtMs;
    if (next.advertisementHex === null) next.advertisementHex = old.advertisementHex;
    if (next.rssi === null) next.rssi = old.rssi;
    peers.delete(oldKey);
  } else {
    peers.delete(oldKey);
    old.peerId = peerId;
    peers.set(peerId, old);
  }
  notify();
}

export function recordPeerConnected(
  peerId: string,
  mtu: number,
  cccdSubscribed: boolean | null,
): void {
  const peer = ensurePeer(peerId);
  peer.gattState = 'connected';
  peer.mtu = mtu;
  peer.cccdSubscribed = cccdSubscribed;
  peer.lastSeenAtMs = Date.now();
  notify();
}

export function recordPeerDisconnected(peerId: string): void {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.gattState = 'disconnected';
  notify();
}

// ------------------------------------------------------------------ frames

export function recordFragmentsSent(peerId: string, count: number): void {
  if (count <= 0) return;
  ensurePeer(peerId).frames.fragmentsSent += count;
  notify();
}

export function recordPacketSent(peerId: string): void {
  ensurePeer(peerId).frames.packetsSent += 1;
  notify();
}

export function recordFragmentsReceived(peerId: string, count: number): void {
  if (count <= 0) return;
  ensurePeer(peerId).frames.fragmentsReceived += count;
  notify();
}

export function recordIncompleteFragmentSet(peerId: string): void {
  ensurePeer(peerId).frames.incompleteFragmentSets += 1;
  notify();
}

export function recordPacketReceived(peerId: string): void {
  ensurePeer(peerId).frames.packetsReceived += 1;
  notify();
}

export function recordDedupDrop(peerId: string | null): void {
  dedupDropTotal += 1;
  if (peerId !== null) {
    const peer = peers.get(peerId);
    if (peer) peer.frames.dedupDrops += 1;
  }
  notify();
}

// ---------------------------------------------------------------- messages

export function recordMessage(message: DiagnosticsMessage): void {
  messages.push(message);
  while (messages.length > MAX_MESSAGES) messages.shift();
  notify();
}

// ------------------------------------------------------------- permissions

export function setDiagnosticsPermissions(report: DiagnosticsPermissionReport): void {
  permissionReport = report;
  notify();
}

// -------------------------------------------------------------- snapshot

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  const nowMs = Date.now();
  pruneScanStarts(nowMs);
  const sortedPeers = [...peers.values()].sort(
    (a, b) => (b.lastSeenAtMs ?? -1) - (a.lastSeenAtMs ?? -1),
  );
  return {
    updatedAtMs: nowMs,
    adapterState,
    advertising: {
      state: advertisingState,
      lastSuccessAtMs: advertisingLastSuccessAtMs,
      lastFailure: advertisingLastFailure,
      advertisementLengthBytes: advertisingLengthBytes,
    },
    scanning: {
      state: scanningState,
      lastFailure: scanningLastFailure,
      scanStartsLast30s: scanStarts.length,
    },
    peers: sortedPeers.map((p) => ({ ...p, frames: { ...p.frames } })),
    messages: [...messages].reverse(),
    permissions: permissionReport,
    dedupDrops: dedupDropTotal,
    ttlDrops: null,
    ttlDropsReason: TTL_DROPS_REASON,
    relayForwards: null,
    relayForwardsReason: RELAY_FORWARDS_REASON,
  };
}

/** Subscribe to collector changes. Returns unsubscribe. */
export function subscribeDiagnostics(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test seam: clear all collector state. */
export function resetDiagnosticsForTests(): void {
  adapterState = 'unknown';
  advertisingState = 'stopped';
  advertisingLastSuccessAtMs = null;
  advertisingLastFailure = null;
  advertisingLengthBytes = null;
  scanningState = 'stopped';
  scanningLastFailure = null;
  scanStarts = [];
  peers.clear();
  messages.length = 0;
  permissionReport = null;
  dedupDropTotal = 0;
  listeners.clear();
}
