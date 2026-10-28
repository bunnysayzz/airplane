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

export type DiagnosticsAttemptOutcome = 'ok' | 'failed' | 'queued' | 'skipped';

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
  /**
   * Per-conversation sender sequence. Null until the durable outbox (R5)
   * assigns one: sequence counters must survive restart to stay true,
   * and R4 deliberately assigns no volatile in-memory sequence that a
   * restart would reset into duplicate numbers.
   */
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

// ------------------------------------------------------------ log sink
// LOG queue item: the automatic log file. The sink receives only the
// kind + detail pairs built below. No hook below receives post text,
// location, or cell ids, so none can reach the file. Full peer ids
// DO reach the hooks (callers pass resolved ids), so the log call
// sites below never log a raw peer id: peerLogLabel truncates a hex
// id to its first 8 chars plus a truncation marker, and replaces a
// mac: address with a short stable-per-session alias. The peers map
// stays keyed by the full id; only the log label is redacted, and the
// screen reads the snapshot, not the log lines, so no consumer changes.
// The message hook drops the message id on purpose (see recordMessage).
// A throwing sink must never break the collector.
type DiagnosticsLogSink = (kind: string, detail: string) => void;
let logSink: DiagnosticsLogSink | null = null;

export function setDiagnosticsLogSink(sink: DiagnosticsLogSink | null): void {
  logSink = sink;
}

function logEvent(kind: string, detail: string): void {
  if (logSink === null) return;
  try {
    logSink(kind, detail);
  } catch {
    // logging never breaks diagnostics
  }
}

/**
 * Log label for a peer id. Never the full 64-char id and never a
 * mac: address: hex ids (full or tag:) keep only their first 8 chars
 * plus a truncation marker, mac: addresses map to a short alias that
 * is stable for the session so sightings of one peer stay grouped
 * without revealing the address. Short ids pass through unchanged.
 */
const sessionPeerAliases = new Map<string, string>();

function peerLogLabel(peerId: string): string {
  if (peerId.startsWith('mac:')) {
    let alias = sessionPeerAliases.get(peerId);
    if (alias === undefined) {
      alias = `mac-peer-${sessionPeerAliases.size + 1}`;
      sessionPeerAliases.set(peerId, alias);
    }
    return alias;
  }
  const prefix = peerId.startsWith('tag:') ? 'tag:' : '';
  const hex = prefix ? peerId.slice(prefix.length) : peerId;
  if (/^[0-9a-fA-F]+$/.test(hex)) {
    return hex.length > 8 ? `${prefix}${hex.slice(0, 8)}...` : peerId;
  }
  return peerId.length > 16 ? `${peerId.slice(0, 16)}...` : peerId;
}

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // a broken subscriber must not break the collector
    }
  }
}

// Snapshot storm guard: collector record calls arrive in bursts (about 100
// dedup drops in about 2 seconds on foreground transitions). Notifying every
// listener per record re-renders the Diagnostics screen dozens of times per
// second. Trailing-edge throttle: the first record in a window schedules one
// fire 250 ms out; later records in the window ride along, because the
// snapshot is rebuilt from current state on fire, so no event data is lost.
const DIAGNOSTICS_NOTIFY_THROTTLE_MS = 250;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notifyThrottled(): void {
  if (notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    notify();
  }, DIAGNOSTICS_NOTIFY_THROTTLE_MS);
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
  logEvent('adapter', state);
  notifyThrottled();
}

// ------------------------------------------------------------ advertising

export function recordAdvertiseSuccess(advertisementLengthBytes: number): void {
  advertisingState = 'started';
  advertisingLastSuccessAtMs = Date.now();
  advertisingLastFailure = null;
  advertisingLengthBytes = advertisementLengthBytes;
  logEvent('advertise', `started ${advertisementLengthBytes}B`);
  notifyThrottled();
}

export function recordAdvertiseFailure(code: string): void {
  advertisingState = 'stopped';
  advertisingLastFailure = code;
  logEvent('advertise', `failed ${code}`);
  notifyThrottled();
}

export function recordAdvertiseStopped(): void {
  advertisingState = 'stopped';
  logEvent('advertise', 'stopped');
  notifyThrottled();
}

// ---------------------------------------------------------------- scanning

export function recordScanStarted(): void {
  scanningState = 'started';
  logEvent('scan', 'started');
  scanStarts.push(Date.now());
  pruneScanStarts(Date.now());
  notifyThrottled();
}

export function recordScanStopped(): void {
  scanningState = 'stopped';
  logEvent('scan', 'stopped');
  notifyThrottled();
}

export function recordScanFailure(code: string): void {
  scanningLastFailure = code;
  logEvent('scan', `failed ${code}`);
  notifyThrottled();
}

// ------------------------------------------------------------------- peers

export function recordPeerSeen(peerId: string, rssi: number, advertisementHex: string): void {
  const peer = ensurePeer(peerId);
  peer.lastSeenAtMs = Date.now();
  peer.rssi = rssi;
  peer.advertisementHex = advertisementHex;
  if (peer.gattState !== 'connected') peer.gattState = 'seen';
  logEvent('peer', `seen ${peerId} rssi ${rssi} ad ${advertisementHex}`);
  notifyThrottled();
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
  logEvent('peer', `resolved ${peerLogLabel(oldKey)} -> ${peerLogLabel(peerId)}`);
  notifyThrottled();
}

export function recordPeerConnected(
  peerId: string,
  mtu: number,
  cccdSubscribed: boolean | null,
): void {
  logEvent('peer', `connected ${peerLogLabel(peerId)} mtu ${mtu} cccd ${cccdSubscribed}`);
  const peer = ensurePeer(peerId);
  peer.gattState = 'connected';
  peer.mtu = mtu;
  peer.cccdSubscribed = cccdSubscribed;
  peer.lastSeenAtMs = Date.now();
  notifyThrottled();
}

export function recordPeerDisconnected(peerId: string): void {
  const peer = peers.get(peerId);
  if (!peer) return;
  logEvent('peer', `disconnected ${peerLogLabel(peerId)}`);
  peer.gattState = 'disconnected';
  notifyThrottled();
}

// ------------------------------------------------------------------ frames

export function recordFragmentsSent(peerId: string, count: number): void {
  if (count <= 0) return;
  logEvent('frames', `${peerLogLabel(peerId)} fragments-sent ${count}`);
  ensurePeer(peerId).frames.fragmentsSent += count;
  notifyThrottled();
}

export function recordPacketSent(peerId: string): void {
  logEvent('frames', `${peerLogLabel(peerId)} packet-sent`);
  ensurePeer(peerId).frames.packetsSent += 1;
  notifyThrottled();
}

export function recordFragmentsReceived(peerId: string, count: number): void {
  if (count <= 0) return;
  logEvent('frames', `${peerLogLabel(peerId)} fragments-received ${count}`);
  ensurePeer(peerId).frames.fragmentsReceived += count;
  notifyThrottled();
}

export function recordIncompleteFragmentSet(peerId: string): void {
  logEvent('frames', `${peerLogLabel(peerId)} incomplete-fragment-set`);
  ensurePeer(peerId).frames.incompleteFragmentSets += 1;
  notifyThrottled();
}

export function recordPacketReceived(peerId: string): void {
  logEvent('frames', `${peerLogLabel(peerId)} packet-received`);
  ensurePeer(peerId).frames.packetsReceived += 1;
  notifyThrottled();
}

export function recordDedupDrop(peerId: string | null): void {
  logEvent('frames', `dedup-drop ${peerId === null ? 'unknown-peer' : peerLogLabel(peerId)}`);
  dedupDropTotal += 1;
  if (peerId !== null) {
    const peer = peers.get(peerId);
    if (peer) peer.frames.dedupDrops += 1;
  }
  notifyThrottled();
}

// ---------------------------------------------------------------- messages

export function recordMessage(message: DiagnosticsMessage): void {
  // Log direction, size, status and attempt outcomes only. The message
  // id is deliberately NOT logged: it is not needed to diagnose a step,
  // and keeping ids out keeps the shareable file to diagnostics data.
  const attempts = message.attempts
    .map((a) => `${a.transport}:${a.outcome}${a.detail !== null ? `:${a.detail}` : ''}`)
    .join(',');
  logEvent('message', `${message.direction} ${message.sizeBytes}B ${message.finalStatus} ${attempts}`);
  messages.push(message);
  while (messages.length > MAX_MESSAGES) messages.shift();
  notifyThrottled();
}

// ------------------------------------------------------------- permissions

export function setDiagnosticsPermissions(report: DiagnosticsPermissionReport): void {
  logEvent(
    'permissions',
    `scan=${report.scan} advertise=${report.advertise} connect=${report.connect} location=${report.location}`,
  );
  permissionReport = report;
  notifyThrottled();
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
  logSink = null;
  sessionPeerAliases.clear();
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}
