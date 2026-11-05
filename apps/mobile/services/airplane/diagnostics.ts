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
   * Per-sender message sequence, durable across restarts: posts carry
   * it as a signed seq tag, DMs as a field inside the sealed rumor.
   * The counter lives in KV and increments only for messages that
   * reach signing (posts) or sealing (DMs), so a gap in a receiver
   * log means the message never arrived, not a renumbering. Null
   * when the sender is an older version with no number, or when the
   * counter was unavailable: the line then reads seq=none, never a
   * guessed number.
   */
  sequence: number | null;
  sizeBytes: number;
  direction: 'outbound' | 'inbound';
  /**
   * Traffic class of the message, kind only, never content: a size-only
   * line made a post indistinguishable from a DM, which left the
   * v0.1.23 regression question of a lost 163B item unanswerable.
   */
  kind: 'post' | 'dm' | 'star' | 'reshare' | 'receipt' | 'other';
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
  // Iterate a snapshot copy: a subscriber that subscribes or
  // unsubscribes during notification must not change who gets visited.
  for (const cb of [...listeners]) {
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
    // Cap check runs BEFORE insertion, so the map never exceeds the
    // cap by one: the old post-insertion check skipped eviction
    // exactly when the new peer (null lastSeen) was itself stalest.
    // Eviction prefers a seen-only or disconnected peer over a
    // connected one, whose counters are live, and takes the stalest
    // within the preferred class.
    if (peers.size >= MAX_PEERS) {
      let victim: string | null = null;
      let victimRank = 2;
      let victimAt = Number.POSITIVE_INFINITY;
      for (const [id, p] of peers) {
        const rank = p.gattState === 'connected' ? 1 : 0;
        const at = p.lastSeenAtMs ?? -1;
        if (rank < victimRank || (rank === victimRank && at < victimAt)) {
          victimRank = rank;
          victimAt = at;
          victim = id;
        }
      }
      if (victim !== null) peers.delete(victim);
    }
    peer = newPeer(peerId);
    peers.set(peerId, peer);
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

/** Transport start failure: one Diagnostics log line (no secret detail). */
export function recordTransportFailure(code: string): void {
  logEvent('transport', `start failed ${code}`);
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
  // A failed scan is a stopped scan: previously the failure was only
  // logged while scanningState stayed started, so Diagnostics kept
  // showing a live scan on a dead radio. The transport reclassifies the
  // adapter state separately (see the port onScanFailure callback).
  scanningState = 'stopped';
  logEvent('scan', `failed ${code}`);
  notifyThrottled();
}

// Scan sighting summary (mesh-scan fix, gap 109 comparable form):
// counts of discover events in one flush window, split into
// mesh-tagged and non-mesh, plus the manufacturer data shapes seen
// (company id hex and byte length only). Two phones' lines are only
// comparable when the window and the counting are the same, so the
// line now labels both: windowMs is the elapsed ms the window actually
// covered (windows flush on the first sighting at or past 60 s, so a
// window is 60 s or longer, never silently a different length), and
// unique/meshUnique count distinct peripheral ids in the window, so
// one chatty advertiser re-broadcasting cannot inflate a phone's total
// past another phone's. Counts and company ids are not identifiers:
// no device ids, names, or RSSI here. This line is what lets the next
// device run tell "scanner delivered nothing" apart from "scanner
// delivered packets but no mesh tag".
// Gap 110: when a flushed window reports zero mesh sightings after an
// earlier window reported mesh sightings, one distinct drop line is
// emitted (once per drop, until mesh sightings return). It observes
// only; it does not change scanning, connecting, or retry behavior.
let scanMeshSeenBefore = false;
let scanMeshDropLogged = false;

export function recordScanSightings(
  total: number,
  mesh: number,
  nonMesh: number,
  manufacturerSummary: string,
  windowMs: number,
  uniqueTotal: number,
  uniqueMesh: number,
): void {
  logEvent(
    'scan',
    `sightings window=${windowMs}ms total=${total} mesh=${mesh} nonmesh=${nonMesh} unique=${uniqueTotal} meshUnique=${uniqueMesh} md=${manufacturerSummary}`,
  );
  if (mesh > 0) {
    scanMeshSeenBefore = true;
    scanMeshDropLogged = false;
  } else if (total > 0 && scanMeshSeenBefore && !scanMeshDropLogged) {
    scanMeshDropLogged = true;
    logEvent('scan', 'mesh-sightings-zero-after-seen');
  }
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
    if (next.mtu === null) next.mtu = old.mtu;
    if (next.cccdSubscribed === null) next.cccdSubscribed = old.cccdSubscribed;
    if (next.gattState === 'seen' && old.gattState !== 'seen') next.gattState = old.gattState;
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

/** MAC addresses must never reach the log file (P0-2): a failure code
 * built from a native error can carry the peer BLE address, so every
 * connect failure code is scrubbed here, whatever the caller passed. */
const MAC_ADDRESS_RE = /[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}/g;

function scrubConnectFailureCode(code: string): string {
  return code.replace(MAC_ADDRESS_RE, 'mac-peer');
}

/**
 * Stage-tagged auto-connect failure line. Log-only on purpose: a single
 * peer failing to connect must not flip the scanning state (that is what
 * recordScanFailure is for, and it does flip it). The port schedules one
 * bounded retry for the same bleId; this line is its only trail.
 */
export function recordConnectFailure(code: string): void {
  logEvent('peer', `connect failed ${scrubConnectFailureCode(code)}`);
  notifyThrottled();
}

/**
 * Updater outcome lines. The detail is a fixed outcome token plus, at
 * most, a version string or a short failure code: versions and codes
 * are not identifiers, so a check result line can never leak identity,
 * location, or content. Every check (launch and manual), every
 * download, and every install outcome logs exactly one line, so a
 * missing result line can no longer be read as "the check never ran".
 */
export type UpdateLogDetail =
  | `check up-to-date ${string}`
  | `check available ${string}`
  | `check failed ${string}`
  | `download started ${string}`
  | `download progress ${number}`
  | `download failed ${string}`
  | `verify ok ${string}`
  | `verify failed ${string}`
  | `install intent fired ${string}`
  | `install failed ${string}`
  | `browser fallback ${string}`
  | `permission required ${string}`
  | `permission denied ${string}`;

export function recordUpdateEvent(detail: UpdateLogDetail): void {
  logEvent('update', detail);
}

/**
 * Test inbox upload lines. The id is never logged: the stored object
 * pathname is a timestamp plus random characters plus version, but the
 * upload line needs no reference at all, only the outcome, so the
 * tester is never asked to relay anything and the file stays free of
 * anything that looks like a handle to chase.
 */
export type InboxLogDetail =
  | 'upload started'
  | 'upload sent'
  | `upload failed ${string}`
  | `upload truncated original=${number}`
  | `read failed ${string}`;

export function recordInboxEvent(detail: InboxLogDetail): void {
  logEvent('inbox', detail);
}

/** Service lifecycle failures that used to die in a swallowed catch:
 * a launch start that fails must leave a line, not silence. */
export type ServiceLogDetail = `dm start failed ${string}` | 'sync pass failed' | `dm ${string}` | `relay resubscribe since ${number}`;

export function recordServiceEvent(detail: ServiceLogDetail): void {
  logEvent('service', detail);
}

/**
 * Throttled drop line for BLE inbound drops (peer-limit drops, malformed
 * write drops). Log-only and kind-scoped: the sink already throttles
 * bursts elsewhere, and this hook is for classes the port counts as
 * silently dropped, not for per-frame traffic. No snapshot counter is
 * added, so no store or snapshot schema changes.
 */
export function recordBleDrop(kind: string, detail: string): void {
  logEvent('ble-drop', `${kind} ${detail}`);
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
  // Log direction, kind, sequence, size, status and attempt outcomes
  // only. The message id is deliberately NOT logged: it is not needed
  // to diagnose a step, and keeping ids out keeps the shareable file
  // to diagnostics data. The sequence number is what traces one
  // message across both phones logs: a number present on the sender
  // side and missing on the receiver side is a lost message.
  const attempts = message.attempts
    .map((a) => `${a.transport}:${a.outcome}${a.detail !== null ? `:${a.detail}` : ''}`)
    .join(',');
  const seq = message.sequence === null ? 'seq=none' : `seq=${message.sequence}`;
  // Lines without a known transport (DM arrivals routed without a
  // channel) carry no attempts segment rather than a fabricated one.
  const attemptsText = attempts.length > 0 ? ` ${attempts}` : '';
  logEvent('message', `${message.direction} ${message.kind} ${seq} ${message.sizeBytes}B ${message.finalStatus}${attemptsText}`);
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

// ------------------------------------------------------------ UI events
// UI interaction log: tap and navigation lines for the shareable file.
// Privacy by construction: call sites pass action names (constants)
// and, at most, one id. The id is accepted only when it looks like an
// id: hex (with an optional tag: prefix) or a mac: address, in which
// case it is truncated or aliased exactly like peer log labels.
// Anything else (post text, message text, coordinates, pasted keys,
// clipboard content) is dropped and the action name alone is logged,
// so a call site that only has sensitive content available can never
// leak it. UI events change no snapshot state, so no notify is needed.
// Lines go through the same sink as every other event, so they
// survive restart via the writer load path and respect the rotation
// caps in pushLine exactly like other lines.
const UI_ACTION_RE = /^[a-z][a-z0-9:_-]{0,63}$/;
const UI_ID_HEX_RE = /^(tag:)?[0-9a-fA-F]+$/;

function uiTargetLabel(targetId: string): string | null {
    if (targetId.startsWith('mac:')) return peerLogLabel(targetId);
    if (UI_ID_HEX_RE.test(targetId)) return peerLogLabel(targetId);
    return null;
}

/**
 * Location outcome lines. The detail is a fixed outcome token from this
 * union, never a coordinate, cell, or post text: the type makes it
 * impossible for a call site to pass a coordinate through this function,
 * so a location line in the shared log can never leak where the user is.
 * Warm-up outcomes diagnose the publish cliff (a submit with no
 * published line is otherwise indistinguishable from a pending submit);
 * revalidate outcomes show whether the background refresh is running.
 */
export type LocationLogDetail =
  | 'warmup started'
  | 'warmup served-cached'
  | 'warmup fresh-ok'
  | 'warmup fresh-failed'
  | 'warmup last-known'
  | 'warmup no-coordinates'
  | 'warmup skipped denied'
  | 'warmup skipped undetermined'
  | 'fresh last-known'
  | 'watch started'
  | 'watch fresh-ok'
  | 'watch failed'
  | 'watch cancelled backgrounded'
  | 'revalidate started'
  | 'revalidate ok'
  | `revalidate failed ${string}`
  | 'provider stale'
  | 'setup permission granted'
  | 'setup permission denied'
  | 'setup permission undetermined'
  | 'compose permission granted'
  | 'compose permission denied'
  | 'compose permission undetermined';

export function recordLocationEvent(detail: LocationLogDetail): void {
  logEvent('location', detail);
}

export function recordUiEvent(action: string, targetId?: string): void {
    if (!UI_ACTION_RE.test(action)) {
        logEvent('ui', 'tap invalid-action');
        return;
    }
    let detail = `tap ${action}`;
    if (targetId !== undefined) {
        const label = uiTargetLabel(targetId);
        if (label !== null) detail += ` ${label}`;
    }
    logEvent('ui', detail);
}

// No slash: a raw route path must never pass as a screen name.
const UI_SCREEN_RE = /^[a-zA-Z0-9_()-]{1,64}$/;

export function recordUiNavigation(direction: 'forward' | 'back', screen: string): void {
    const safe = UI_SCREEN_RE.test(screen) ? screen : 'unknown-screen';
    logEvent('ui', `nav ${direction} ${safe}`);
}

export function resetDiagnosticsForTests(): void {
  adapterState = 'unknown';
  advertisingState = 'stopped';
  advertisingLastSuccessAtMs = null;
  advertisingLastFailure = null;
  advertisingLengthBytes = null;
  scanningState = 'stopped';
  scanningLastFailure = null;
  scanStarts = [];
  scanMeshSeenBefore = false;
  scanMeshDropLogged = false;
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
