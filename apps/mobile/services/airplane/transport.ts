// SPDX-License-Identifier: Apache-2.0
// Transport manager: owns the HybridTransport lifecycle.
//
// - BLE transport runs always (real GATT port on device; fails closed to
//   inert when the radio, permissions, or native modules are unavailable).
// - Nostr transport starts/stops with connectivity (NetInfo, no Google
//   Play Services dependency).
// - Incoming posts from any source are stored and fed to the UI.
// - WorldSync runs when online to push unconfirmed posts and check relays.
//
// RETRY POLICIES (actual, per transport; no single ladder exists):
// - Nostr reconnect: base 5 s doubling, capped at 60 s, plus/minus 20%
//   jitter, while started (see packages/transport/src/nostr.ts).
// - DM outbox: [0, 1, 5, 30, 120] s, capped at 5 attempts, then Failed
//   (see packages/transport/src/dm.ts).
// - WorldSync: fixed 60 s timer, no backoff (SYNC_INTERVAL_MS below).
// - BLE: no retry backoff at all for connect or send.

import type { NetInfoState } from '@react-native-community/netinfo';
import {
  HybridTransport,
  BleTransport,
  WorldSync,
  applyPeerFailure,
  applyRelayOk,
  applyRelayRejection,
  healthSummary,
  isDuplicateRejection,
  isPeerHealthy,
  planSend,
  type PeerHealth,
  type RelayHealth,
  type TransportHealth,
  type WorldConfirmStore,
  type RouteResult,
} from '@airplane/transport';
import type { SignedEvent, TransportPort, Hex64 } from '@airplane/protocol';
import { encodeEvent, toHex, verifyEvent } from '@airplane/protocol';
import { getStore } from './store';
import { EVENT_KIND_POST, EVENT_KIND_RECEIPT, EVENT_KIND_RESHARE, EVENT_KIND_STAR, reshareTargetId } from '@airplane/protocol';
import { applyIncomingStar, markStarPostKnown } from './stars';
import {
  markResharePostKnown,
  recordReshareEvent,
  rehydrateReshares,
} from './reshares';
import { notifyFeedListeners } from './feed';
import { getDevicePublicKey, crypto } from './identity';
import { registerDmBlePort, flushDmOutboxIfStarted, refreshDmSubscriptionIfStarted, getDmService, getDmRelayPoolHealth } from './dm';
import { loadRelayUrls } from '../../src/lib/relays';
import { addBreadcrumb } from '../../src/sentry';
import { GattBlePort, defaultBleDeps, type BleNativeDeps } from './ble/gatt';
import { ensureBlePermissions, checkBlePermissions, requestBlePermissions } from './ble/permissions';
import {
  recordAdvertiseStopped,
  recordDedupDrop,
  recordMessage,
  recordScanStopped,
  recordServiceEvent,
  recordTransportFailure,
  setDiagnosticsAdapterState,
  type DiagnosticsMessageAttempt,
} from './diagnostics';

/**
 * Map a store failure onto a short reason code for the Diagnostics line.
 * The raw error is never logged: it can carry SQL text, and the line
 * needs a stable outcome word, not a dump. Transient lock contention
 * (backfill bursts writing at once) is the retryable class; anything
 * else still retries, because a second attempt costs milliseconds, and
 * a final failure triggers the inbound recovery below (the Hybrid seen
 * mark is forgotten and the relays are asked for the id once), because
 * a relay replay of an already seen id would be dropped as a duplicate
 * within this launch.
 */
function storeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/locked|busy/i.test(message)) return 'locked';
  if (/constraint|unique/i.test(message)) return 'constraint';
  return 'failed';
}

const STORE_SAVE_ATTEMPTS = 3;
const STORE_SAVE_DELAYS_MS = [100, 300];

/** Run one store save with bounded retries. Never throws. */
async function saveWithRetry<T>(
  save: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  let lastCode = 'failed';
  for (let attempt = 0; attempt < STORE_SAVE_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, value: await save() };
    } catch (error: unknown) {
      lastCode = storeFailureCode(error);
      if (attempt < STORE_SAVE_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, STORE_SAVE_DELAYS_MS[attempt]));
      }
    }
  }
  return { ok: false, code: lastCode };
}

/**
 * NetInfo is a native module. If it fails to load (not linked, Expo Go,
 * etc.), the app must still launch - transport just runs offline-only.
 * We load it lazily so a broken native module can't crash the app at import.
 */
let NetInfoModule: {
  fetch: () => Promise<NetInfoState>;
  addEventListener: (cb: (s: NetInfoState) => void) => () => void;
} | null = null;
let netInfoLoadAttempted = false;

/** Test seam: reset the NetInfo module cache so tests can simulate load failure. */
export function __resetNetInfoForTests(): void {
  NetInfoModule = null;
  netInfoLoadAttempted = false;
}

function getNetInfo() {
  if (netInfoLoadAttempted) return NetInfoModule;
  netInfoLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-community/netinfo');
    NetInfoModule = mod.default ?? mod;
  } catch {
    NetInfoModule = null;
  }
  return NetInfoModule;
}

/**
 * Real BLE GATT port. Constructed defensively: the native libraries are
 * lazy-required, and every radio failure fails closed (the port's methods
 * throw descriptive Errors or stay inert; the app keeps running Nostr-only).
 * RADIO-UNVERIFIED - see services/airplane/ble/gatt.ts.
 */
/**
 * Mid-session scan failure (mesh-scan fix): intentionally no longer
 * reclassifies the radio. A scan failure used to set the radio
 * unavailable, and the startup path then tore advertising down too,
 * leaving the phone mute and deaf until relaunch. Advertising stays
 * up across a scan failure now (see bringUpBleRadio), the failure
 * itself is already recorded in diagnostics by the port, and scanning
 * recovers via the retry timer, foreground re-validation, adapter-on
 * events, or manual Retry. The callback wiring stays so a future use
 * has a place to hook in.
 */
async function handleScanFailure(_code: string): Promise<void> {
  return;
}

function makeBlePort(): { port: TransportPort; close: () => Promise<void> } {
  let deps: BleNativeDeps;
  try {
    deps = defaultBleDeps(ensureBlePermissions, checkBlePermissions);
    deps.onScanFailure = (code) => {
      void handleScanFailure(code);
    };
  } catch {
    // Even building the deps failed: fall back to a fully inert port.
    return { port: new NoopBlePort(), close: async () => {} };
  }
  const port = new GattBlePort(deps);
  return { port, close: () => port.close().catch(() => {}) };
}

/**
 * No-op BLE port: last-resort fallback when even the GATT port cannot be
 * constructed. Satisfies TransportPort so HybridTransport can start.
 */
class NoopBlePort implements TransportPort {
  async advertise(): Promise<void> {}
  async stopAdvertise(): Promise<void> {}
  async scan(): Promise<() => void> {
    return () => {};
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
  onReceive(): () => void {
    return () => {};
  }
}

let hybrid: HybridTransport | null = null;
let sync: WorldSync | null = null;
let netUnsub: (() => void) | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Last connectivity state applied to the transport, or null before any
 * state has been applied. Transitions only (not every listener fire) drive
 * the transport, so duplicate events are no-ops and each real change gets
 * exactly one breadcrumb for the device-check log trail.
 */
let lastOnline: boolean | null = null;
/**
 * Gap 111, observability only: the raw NetInfo state words from the
 * most recent listener fire or fetch, kept so a relay skip for
 * "network not validated" can say why in state words (connected,
 * reachable, type), instead of leaving a stuck validation unexplained.
 * State words only: no SSID, no address, no identifier. This never
 * changes connectivity behavior: applyConnectivity still owns the
 * online/offline decision, and this summary is only read for a log
 * line. Null before any NetInfo state has arrived.
 */
let lastNetInfoSummary: string | null = null;

/** Render one NetInfo state as state words only, for the gap 111 log line. */
function netInfoWords(state: NetInfoState): string {
  const reachable =
    state.isInternetReachable === null ? 'null' : String(!!state.isInternetReachable);
  return `connected=${!!state.isConnected} reachable=${reachable} type=${state.type ?? 'unknown'}`;
}
/**
 * True once any connectivity state has been applied (listener or fetch).
 * False before the first state and forever when the NetInfo module fails
 * to load: that is the router's unknown-network state, which gets the
 * shortened relay deadline instead of the full one (see startTransport).
 */
let connectivityKnown = false;
let blePort: { port: TransportPort; close: () => Promise<void> } | null = null;
let bleScanUnsub: (() => void) | null = null;
/**
 * Scan health and retry (mesh-scan fix). bleScanUp is true only while a
 * scan is actually running; advertising can be up while scanning is
 * down, and that split is exactly what the old code hid by tearing
 * the whole radio down on any scan failure. scanRetryTimer re-runs
 * bring-up with backoff after a scan failure; at most one timer is
 * ever pending, and it is cleared on teardown, on stop, and on scan
 * success. bringUpPromise serializes concurrent bring-ups: without
 * it, two bring-ups racing at startup each ran the native scan and
 * the logs showed double scan started lines.
 */
let bleScanUp = false;
let scanRetryTimer: ReturnType<typeof setTimeout> | null = null;
let scanRetryAttempt = 0;
const SCAN_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];
/**
 * Advertise retry (v0.1.31). advertiseRetryTimer re-runs advertise()
 * with backoff after an advertise failure; at most one timer is ever
 * pending, and it is cleared on teardown, on stop, and on advertise
 * success. The v0.1.30 window had one advertise failure per phone at
 * startup ("Not support bluetoothLeAdvertiser") and no retry at all:
 * the radio stayed dark until the next restart.
 */
let advertiseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let advertiseRetryAttempt = 0;
const ADVERTISE_RETRY_DELAYS_MS = [2000, 5000, 15000];
let bringUpPromise: Promise<void> | null = null;
/**
 * True once startTransport() has failed and not since succeeded. The
 * launch caller swallows the throw (launch must never die on transport),
 * but the failure must still be visible: the mesh pill reports offline,
 * never mesh, while this is set, and a Diagnostics line is recorded.
 */
let transportStartFailed = false;

/** Whether the last transport start failed (cleared by a later success). */
export function getTransportStartFailed(): boolean {
  return transportStartFailed;
}
/**
 * BLE radio state. 'permission-blocked' means the OS grants are missing and
 * the priming UI (BlePrime) owns the request; 'unavailable' means the radio
 * failed for another reason (no BLE hardware, native lib missing).
 */
export type BleRadioState = 'starting' | 'on' | 'permission-blocked' | 'unavailable';
let bleRadioState: BleRadioState = 'starting';
/** True once the radio has been up this launch. Guards foreground
 * re-validation: a radio that never came up is the priming UI's job, not
 * an automatic bring-up on every foreground. */
let radioWasOn = false;

const SYNC_INTERVAL_MS = 60_000; // re-check World status every minute when online
const PRUNE_INTERVAL_MS = 3600_000; // retention cleanup at most hourly via sync ticks

let pruneInFlight: Promise<void> | null = null;
let lastSyncPruneMs = 0;

/**
 * Best-effort retention cleanup: delete rows past the 24 h window (see
 * StorePort.pruneExpired). Never throws, and overlapping calls share one
 * run. Called at startup, on foreground (see _layout), and at most hourly
 * from runSync. Note: the first prune after a long install deletes old
 * data by the designed 24 h window; that is the retention rule working,
 * not data loss.
 */
export async function pruneExpiredStore(): Promise<void> {
  if (pruneInFlight) return pruneInFlight;
  pruneInFlight = (async () => {
    try {
      await getStore().pruneExpired(Math.floor(Date.now() / 1000));
    } catch {
      // Retention cleanup must never break launch, sync, or foreground.
    }
  })();
  try {
    await pruneInFlight;
  } finally {
    pruneInFlight = null;
  }
}

function startSyncTimer(): void {
  if (!syncTimer) {
    syncTimer = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
  }
}

function stopSyncTimer(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/** Mirror the BLE radio state into the diagnostics collector. */
function syncDiagnosticsAdapterState(): void {
  setDiagnosticsAdapterState(
    bleRadioState === 'on'
      ? 'on'
      : bleRadioState === 'permission-blocked'
        ? 'permission-blocked'
        : bleRadioState === 'unavailable'
          ? 'unavailable'
          : 'starting',
  );
}

/**
 * Trailing feed-notify coalescing for inbound bursts: a cold-cache relay
 * replay delivers many events in seconds, and one notify per event
 * re-rendered the timeline per event while scrolled down. One timer per
 * burst notifies once, 250ms after the last event in the burst (the same
 * window the timeline already uses at top).
 */
let feedNotifyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFeedNotify(): void {
  if (feedNotifyTimer) return;
  feedNotifyTimer = setTimeout(() => {
    feedNotifyTimer = null;
    notifyFeedListeners();
  }, 250);
}

/**
 * Recovery for an inbound event whose save failed on every retry.
 * Bounded to one relay query per id per launch: without the bound,
 * a redelivery that also fails its save would re-query forever.
 * The Hybrid seen mark is forgotten first, so the query response
 * is not dropped as a duplicate at ingress. When no relay is
 * reachable the query sends nowhere and the id is not added to
 * the once-per-launch set, so a later failure can try again;
 * the seen mark is already forgotten, so any redelivery in the
 * meantime can also pass ingress. When the set reaches its cap
 * it clears first, which keeps memory bounded at the cost of
 * allowing a very old id one more query. Never throws. A
 * mesh-only post simply has no relay copy to fetch, so this
 * step is a no-op for it, and the BLE flood seen cache still
 * suppresses a BLE redelivery until it evicts the id.
 */
const failedInboundIds = new Set<string>();
const FAILED_INBOUND_IDS_CAP = 1000;

async function recoverFailedInbound(event: SignedEvent): Promise<void> {
  const idHex = toHex(event.id);
  if (failedInboundIds.has(idHex)) return;
  try {
    hybrid?.forgetSeen(idHex);
    const sent = await hybrid?.nostr.queryByIds([idHex]);
    if (!sent) return;
    if (failedInboundIds.size >= FAILED_INBOUND_IDS_CAP) failedInboundIds.clear();
    failedInboundIds.add(idHex);
  } catch {
    // Best effort only: recovery must never break the caller.
  }
}

/** Test seam: reset the once-per-launch failed inbound set. */
export function __resetFailedInboundForTests(): void {
  failedInboundIds.clear();
}

/**
 * Diagnostics traffic class for an event kind. DM kind 1059 is
 * DM_EVENT_KIND in packages/transport; the app maps it literally here
 * rather than importing the transport package into the app layer.
 */
function messageKindForEventKind(kind: number): 'post' | 'dm' | 'star' | 'reshare' | 'receipt' | 'other' {
  if (kind === EVENT_KIND_POST) return 'post';
  if (kind === EVENT_KIND_RECEIPT) return 'receipt';
  if (kind === EVENT_KIND_STAR) return 'star';
  if (kind === EVENT_KIND_RESHARE) return 'reshare';
  if (kind === 1059) return 'dm';
  return 'other';
}

/**
 * Per-sender post sequence number from the signed seq tag, or null
 * when the sender is an older version (no tag) or the tag is malformed.
 * The tag is part of the signed event, so a tampered number fails
 * signature verification upstream; a missing number is honest, never
 * guessed. Non-post kinds carry no seq tag and always read null.
 */
function postSeqOf(event: SignedEvent): number | null {
  if (event.kind !== EVENT_KIND_POST) return null;
  const row = event.tags.find((tag) => tag[0] === 'seq');
  if (!row) return null;
  const n = Number(row[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

async function handleIncoming(event: SignedEvent, source: string): Promise<void> {
  // Recently seen authors feed the balancer's author catch-up: a
  // friend's post in any cell is worth one targeted query after a
  // replay miss. In-memory only, bounded to 30, full pubkey hex held
  // for the filter but never logged.
  if (event.kind === EVENT_KIND_POST) {
    const authorHex = toHex(event.pubkey);
    const at = recentAuthorHexes.indexOf(authorHex);
    if (at >= 0) recentAuthorHexes.splice(at, 1);
    recentAuthorHexes.push(authorHex);
    while (recentAuthorHexes.length > 30) recentAuthorHexes.shift();
  }
  // STAR MVP: kind-4 events never reach the events table - its schema
  // CHECKs kind IN (1,2,3). They go to the in-memory star counter instead
  // (same BLE + Nostr ingress path, same event-id dedup upstream).
  if (event.kind === EVENT_KIND_STAR) {
    // Stars used to return before the generic inbound line below,
    // so a received star moved data with no message-level line at
    // all. Log it like any other arrival: kind star, received.
    if (source === 'nostr' || source === 'ble') {
      recordMessage({
        id: toHex(event.id),
        sequence: postSeqOf(event),
        sizeBytes: encodeEvent(event).length,
        direction: 'inbound',
        kind: 'star',
        attempts: [
          {
            transport: source === 'nostr' ? 'relay' : 'ble',
            atMs: Date.now(),
            outcome: 'ok',
            detail: null,
          },
        ],
        finalStatus: 'received',
      });
    }
    if (applyIncomingStar(event)) scheduleFeedNotify();
    return;
  }
  // T19: kind-5 reshare/unreshare events never reach the events table
  // either (same CHECK). They go to the reshare counter, are persisted to
  // the reshare_events table for cross-restart rehydration, and a reshare
  // for a post this node does not yet hold triggers a pull-on-demand
  // relay query for the original post (best-effort, once per post per
  // launch; a mesh-only post simply stays pending until BLE delivers it).
  if (event.kind === EVENT_KIND_RESHARE) {
    const result = recordReshareEvent(event);
    if (result === 'pending') void pullOriginalForReshare(event);
    const saved = await saveWithRetry(() => getStore().saveReshareEvent(event));
    if (source === 'nostr' || source === 'ble') {
      // A reshare arrival used to log only on save failure, so a
      // successful reshare moved data with no message-level line.
      // Success logs received; failure logs receive failed with the
      // reason code. Local publish echoes are not logged as inbound.
      recordMessage({
        id: toHex(event.id),
        sequence: postSeqOf(event),
        sizeBytes: encodeEvent(event).length,
        direction: 'inbound',
        kind: 'reshare',
        attempts: [
          {
            transport: source === 'nostr' ? 'relay' : 'ble',
            atMs: Date.now(),
            outcome: saved.ok ? 'ok' : 'failed',
            detail: saved.ok ? null : `store save failed reshare ${saved.code}`,
          },
        ],
        finalStatus: saved.ok ? 'received' : 'receive failed',
      });
    }
    scheduleFeedNotify();
    return;
  }
  // Diagnostics: 'local' is our own publish echo (already logged as
  // outbound), so only relay and BLE arrivals are logged as inbound.
  if (source === 'nostr' || source === 'ble') {
    recordMessage({
      id: toHex(event.id),
      sequence: postSeqOf(event),
      sizeBytes: encodeEvent(event).length,
      direction: 'inbound',
      kind: messageKindForEventKind(event.kind),
      attempts: [
        {
          transport: source === 'nostr' ? 'relay' : 'ble',
          atMs: Date.now(),
          outcome: 'ok',
          detail: null,
        },
      ],
      finalStatus: 'received',
    });
  }
  const store = getStore();
  // Receipts (kind 2) go through the counting path, not the generic
  // saveEvent path: saveReceipt updates view_counts with
  // (pubkey, post, day) dedup, so a relay view counts exactly once and
  // actually moves the feed. Previously inbound receipts were stored
  // but never counted, so relay views changed nothing.
  if (event.kind === EVENT_KIND_RECEIPT) {
    const receipt = await saveWithRetry(() => getStore().saveReceipt(event));
    if (!receipt.ok) {
      addBreadcrumb('transport: inbound receipt store failed', {
        id: toHex(event.id).slice(0, 16),
      });
      if (source === 'nostr' || source === 'ble') {
        recordMessage({
          id: toHex(event.id),
          sequence: postSeqOf(event),
          sizeBytes: encodeEvent(event).length,
          direction: 'inbound',
          kind: 'receipt',
          attempts: [
            {
              transport: source === 'nostr' ? 'relay' : 'ble',
              atMs: Date.now(),
              outcome: 'failed',
              detail: `store save failed receipt ${receipt.code}`,
            },
          ],
          finalStatus: 'receive failed',
        });
      }
      return;
    }
    if (receipt.value) notifyFeedListeners();
    return;
  }
  // Store the event (deduped by HybridTransport already).
  // saveEvent is idempotent. A store failure is surfaced in
  // Diagnostics and the feed is NOT notified: an unhandled rejection
  // here used to drop the event while Hybrid already marked it seen.
  // A storage failure must not escape as an unhandled rejection (the
  // caller uses void handleIncoming) and must not be silent: the save
  // retries a bounded number of times first (backfill bursts contend
  // for the store), and only a final failure records a Diagnostics
  // message with its reason code plus a stage-tagged breadcrumb, and
  // drops this pass only. The event is not queued durably here (no
  // inbound queue exists in the store schema). A final failure for a
  // relay or Bluetooth arrival triggers the inbound recovery above:
  // the Hybrid seen mark is forgotten and the relays are asked for
  // the id once, so a redelivery can pass ingress again when the
  // store recovers. After a restart the in-memory seen set clears,
  // so a normal relay replay lands without any recovery step.
  const saved = await saveWithRetry(() => store.saveEvent(event));
  if (!saved.ok) {
    // Local publish echoes are not logged as inbound failures; the
    // breadcrumb below still records them.
    if (source === 'nostr' || source === 'ble') {
      recordMessage({
        id: toHex(event.id),
        sequence: postSeqOf(event),
        sizeBytes: encodeEvent(event).length,
        direction: 'inbound',
        kind: messageKindForEventKind(event.kind),
        attempts: [
          {
            transport: source === 'nostr' ? 'relay' : 'ble',
            atMs: Date.now(),
            outcome: 'failed',
            detail: `store save failed ${saved.code}`,
          },
        ],
        finalStatus: 'receive failed',
      });
    }
    addBreadcrumb('transport: inbound store failed', {
      id: toHex(event.id).slice(0, 16),
    });
    if (source === 'nostr' || source === 'ble') {
      void recoverFailedInbound(event);
    }
    return;
  }
  // A post arriving may release stars and reshares held pending for it.
  if (event.kind === EVENT_KIND_POST) {
    markStarPostKnown(toHex(event.id));
    markResharePostKnown(toHex(event.id));
  }
  scheduleFeedNotify();
}

/**
 * Pull-on-demand for reshare targets (T19): when a reshare arrives for a
 * post this node does not hold, ask the open relays for the original post
 * by id. Responses arrive via the normal onPost path, which marks the post
 * known and releases the pending reshare. Best-effort and once per post
 * per launch: when offline the query sends nowhere, and a mesh-only post
 * stays pending until a BLE peer delivers it. Never throws.
 *
 * The target is marked pulled only when the query actually reached a
 * relay: marking before the query used to block retry for the whole
 * launch after one offline pull. The set is bounded (oldest evicted
 * past 1000) so it cannot grow for the life of the launch.
 */
const pulledPostIds = new Set<string>();
const PULLED_POST_IDS_CAP = 1000;

async function pullOriginalForReshare(event: SignedEvent): Promise<void> {
  const target = reshareTargetId(event);
  if (!target || pulledPostIds.has(target)) return;
  try {
    const sent = await hybrid?.nostr.queryByIds([target]);
    if (!sent) return; // offline: not pulled, so a later reshare retries
    if (pulledPostIds.size >= PULLED_POST_IDS_CAP) {
      const oldest = pulledPostIds.values().next().value as string | undefined;
      if (oldest !== undefined) pulledPostIds.delete(oldest);
    }
    pulledPostIds.add(target);
  } catch {
    // Best-effort: the pending reshare still applies when the post arrives.
  }
}

/** Test seam: clear the pull-on-demand once-per-launch set. */
export function __resetPulledPostsForTests(): void {
  pulledPostIds.clear();
}

async function runSync(): Promise<void> {
  if (!sync || !hybrid?.nostr.online) return;
  // Periodic retention cleanup, throttled to hourly so a 60 s sync tick
  // does not re-prune every minute.
  if (Date.now() - lastSyncPruneMs >= PRUNE_INTERVAL_MS) {
    lastSyncPruneMs = Date.now();
    void pruneExpiredStore();
  }
  try {
    const report = await sync.sync();
    if (report.confirmed.length > 0) {
      notifyFeedListeners(); // globe icons may have appeared
    }
  } catch {
    // Sync failures are non-fatal; retry on next interval. The failure
    // is logged instead of swallowed: a sync that never succeeds must
    // be visible in the next log, not just absent.
    recordServiceEvent('sync pass failed');
  }
}

/**
 * Run one WorldSync pass on demand. Rank 13, foreground trigger: the
 * same pass the connectivity return trigger runs, so a backgrounded
 * post recovers on foreground return without a connectivity flap.
 * Cheap by construction: WorldSync shares an in-flight pass, so
 * concurrent callers (timer, connectivity, foreground) coalesce, and
 * the pass is a no-op while offline or before transport start. It
 * does not restart relay sockets on its own; the connectivity path
 * owns socket lifecycle.
 */
export async function runWorldSyncPass(): Promise<void> {
  await runSync();
}

// ---- Transport load balancer (v0.1.27) ----
//
// The ordered router checks health once at publish time and never
// re-checks: a relay rejection, a flapping link, or a peer arriving
// a second later got no second look, and a relay-OK'd post the
// receiver never fetched stayed confirmed-but-undelivered. The
// balancer is the decision layer on top of the router. It keeps live
// health per path (relay socket state + rejection backoff per relay
// URL, BLE peer-set health, network validation state) and re-attempts
// queued work whenever health changes: peer connects, relay
// recovers, network validates, backoff expires, app foregrounds.
// It never sends anything itself: the router, WorldSync, the post
// outbox drain, and the DM flush do the sending; this layer only
// plans, records outcomes, and triggers re-attempts.
//
// BLE granularity is per peer, not per set (v0.1.31): the radio
// reports sends as a broadcast count, not per peer, so a send
// outcome is folded into the peers that send targeted, but a failure
// on one peer never backs off the others. The GATT layer's own
// sighting cooldown (IDENT failures, 10 s doubling to 60 s) already
// keeps a flapping peer out of the connected set entirely, so a peer
// that cannot connect never reaches the router; the per-peer backoff
// below covers the case the set is connected but no send reaches
// anyone (notify race, dead link).

/** Per-relay health, keyed by relay URL. */
const relayHealthByUrl = new Map<string, RelayHealth>();
/**
 * Per-peer BLE health, keyed by peer tag (first 8 hex). A peer that
 * was never targeted has no entry and counts as healthy; a peer
 * whose sends failed is held out on the doubling ladder until its
 * window ends. The v0.1.27 shared set is gone: one flapping peer
 * held out every peer.
 */
const peerHealthByTag = new Map<string, PeerHealth>();
/**
 * Per-row, per-peer BLE handoff memory for the outbox drain:
 * event id hex -> peer tag -> handoff epoch ms. A drain pass skips a
 * row for a peer it was handed to inside DRAIN_HANDOFF_WINDOW_MS,
 * so the same rows are not handed to the same peer on every health
 * trigger (v0.1.30: 3 to 4 times in a minute). Rows stay queued until
 * World-confirmed; only the re-attempt is deduped, never the row.
 * Bounded: pruned on every drain pass, capped row count.
 */
const drainHandoffByEvent = new Map<string, Map<string, number>>();
const DRAIN_HANDOFF_WINDOW_MS = 120_000;
const DRAIN_HANDOFF_MAX_ROWS = 500;
/**
 * Pacing between drain rows, ms (v0.1.31). Rows go out one at a time
 * with a short gap, not as one back-to-back burst: the v0.1.30
 * simultaneous burst (B draining 7 posts in 130 ms while A drained
 * 6) lost every frame on the wire with no receipt signal, and the
 * comparables pace or serialize for the same reason (Meshtastic
 * retries with backoff, MeshCore 1/2/4/8/16 s). A full app-level ACK
 * frame is the follow-up that closes this for good. Mutable only so
 * tests can set it to 0 (fake timers never advance otherwise).
 */
const DRAIN_ROW_DELAY_MS = 50;
let drainRowDelayMs = DRAIN_ROW_DELAY_MS;
/** Recently seen post authors (full pubkey hex, in-memory only, max 30). */
const recentAuthorHexes: string[] = [];
/** One-shot timer for the nearest backoff expiry re-attempt. */
let balancerRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** In-flight health pass guard (see notifyTransportHealthChanged). */
let balancerHealthRun: Promise<void> | null = null;
let balancerHealthPending = false;
/** Relay pool watchdog timer (see runRelayPoolWatchdog). */
let poolWatchdogTimer: ReturnType<typeof setInterval> | null = null;
/** Watchdog tick interval, ms. */
const POOL_WATCHDOG_INTERVAL_MS = 15_000;
/**
 * Watchdog staleness bound, ms: the watchdog only forces an attempt
 * when no connect was attempted for this long (the reconnect cap), so
 * it never bypasses a live backoff ladder.
 */
const POOL_WATCHDOG_STALE_MS = 60_000;

/** Test seam: reset balancer state between tests. */
export function __resetBalancerForTests(): void {
  relayHealthByUrl.clear();
  peerHealthByTag.clear();
  drainHandoffByEvent.clear();
  recentAuthorHexes.length = 0;
  prevMeshPeers = 0;
  prevDmOpenRelays = 0;
  drainRowDelayMs = DRAIN_ROW_DELAY_MS;
  if (balancerRetryTimer) {
    clearTimeout(balancerRetryTimer);
    balancerRetryTimer = null;
  }
}

/** Test seam: set the inter-row drain pacing delay (0 disables it). */
export function __setDrainRowDelayMsForTests(ms: number): void {
  drainRowDelayMs = ms;
}

/** Current live health snapshot for one routing decision. */
export function buildTransportHealth(): TransportHealth {
  const nowMs = Date.now();
  const relays: RelayHealth[] = [];
  const urls = hybrid?.nostr.relayUrls ?? [];
  for (const url of urls) {
    const known = relayHealthByUrl.get(url);
    relays.push({
      url,
      socketOpen: hybrid?.nostr.getRelayState(url) === 'open',
      lastOkAtMs: known?.lastOkAtMs ?? null,
      lastRejection: known?.lastRejection ?? null,
      backoffUntilMs: known?.backoffUntilMs ?? 0,
      consecutiveRejections: known?.consecutiveRejections ?? 0,
    });
  }
  const connectedPeers = blePeerIdsForPublish(blePort?.port);
  // Per-peer health (v0.1.31): each ready peer carries its own
  // backoff. A peer with no entry was never targeted and counts as
  // healthy; a peer whose sends failed is held out alone, never the
  // whole set. Peers listed here are ready peers only (see
  // blePeerIdsForPublish): a connected-but-not-ready peer cannot
  // receive a notify yet, so it is not a routing target.
  const peers: PeerHealth[] = connectedPeers.map((peerId) => {
    const tag = peerId.slice(0, 8);
    const known = peerHealthByTag.get(tag);
    return {
      tag,
      connected: true,
      unhealthyUntilMs: known?.unhealthyUntilMs ?? 0,
      lastFailure: known?.lastFailure ?? null,
      consecutiveFailures: known?.consecutiveFailures ?? 0,
    };
  });
  // DM pool sockets, when the DM service has started: mutual
  // visibility with the post pool in one snapshot (v0.1.31). A DM
  // pool recovery with a dead post pool now reads in the same line.
  const dmPool = getDmRelayPoolHealth();
  const dmRelays: RelayHealth[] = (dmPool?.urls ?? []).map((url) => ({
    url,
    socketOpen: dmPool?.openUrls.includes(url) ?? false,
    lastOkAtMs: null,
    lastRejection: null,
    backoffUntilMs: 0,
    consecutiveRejections: 0,
  }));
  return {
    relays,
    peers,
    dmRelays,
    networkValidated: lastOnline,
    nowMs,
  };
}

/**
 * Fold a router result's relay rejections into health. A real
 * rejection backs that relay off (and out of the router's rotation
 * via NostrTransport.setRelayBackoff) on the doubling ladder; a
 * "duplicate:" is stored, not a failure, so it backs nothing off.
 * A relay win clears the backoff. Returns the nearest backoff expiry
 * (epoch ms) so the caller can arm one re-attempt timer, or 0.
 */
function noteBalancerRelayResult(result: RouteResult): number {
  const nowMs = Date.now();
  let nearestExpiry = 0;
  for (const { url, reason } of result.relayRejections ?? []) {
    const prev = relayHealthByUrl.get(url) ?? {
      url,
      socketOpen: false,
      lastOkAtMs: null,
      lastRejection: null,
      backoffUntilMs: 0,
      consecutiveRejections: 0,
    };
    const next = applyRelayRejection(prev, reason, nowMs);
    relayHealthByUrl.set(url, next);
    if (!isDuplicateRejection(reason) && next.backoffUntilMs > nowMs) {
      hybrid?.nostr.setRelayBackoff(url, next.backoffUntilMs);
      if (nearestExpiry === 0 || next.backoffUntilMs < nearestExpiry) {
        nearestExpiry = next.backoffUntilMs;
      }
    }
  }
  if (result.transport === 'relay') {
    for (const url of result.relays) {
      const prev = relayHealthByUrl.get(url);
      if (!prev) continue;
      relayHealthByUrl.set(url, applyRelayOk(prev, nowMs));
    }
  }
  return nearestExpiry;
}

/**
 * Fold one BLE send outcome into per-peer health. A broadcast that
 * reached a peer clears that peer's backoff; a broadcast that
 * reached nobody backs off the peers it targeted, each on its own
 * doubling ladder. A failure on one peer never holds out the others.
 * The broadcast count cannot attribute a success to one peer, so a
 * success clears every targeted peer: the radio path works, and a
 * peer that still cannot receive is excluded by its own connect
 * state or readiness, not by this ladder. Returns the nearest
 * backoff expiry (epoch ms) or 0.
 */
function noteBlePeerOutcome(peerIds: string[], sentCount: number): number {
  const nowMs = Date.now();
  let nearestExpiry = 0;
  for (const peerId of peerIds) {
    const tag = peerId.slice(0, 8);
    const prev = peerHealthByTag.get(tag) ?? {
      tag,
      connected: true,
      unhealthyUntilMs: 0,
      lastFailure: null,
      consecutiveFailures: 0,
    };
    if (sentCount > 0) {
      peerHealthByTag.set(tag, { ...prev, connected: true, unhealthyUntilMs: 0, consecutiveFailures: 0 });
    } else {
      const next = applyPeerFailure({ ...prev, connected: true }, 'broadcast reached no peers', nowMs);
      peerHealthByTag.set(tag, next);
      if (next.unhealthyUntilMs > nearestExpiry) nearestExpiry = next.unhealthyUntilMs;
    }
  }
  return nearestExpiry;
}

/** Arm one re-attempt when the nearest backoff expires. */
function armBalancerRetryTimer(untilMs: number): void {
  if (untilMs <= Date.now()) return;
  if (balancerRetryTimer) return; // one timer is enough; it re-arms if more remain
  const delayMs = Math.min(untilMs - Date.now(), 60_000);
  balancerRetryTimer = setTimeout(() => {
    balancerRetryTimer = null;
    void notifyTransportHealthChanged('backoff expired');
  }, delayMs);
}

/**
 * Author-targeted relay catch-up: ask open relays for recent posts
 * from DM-thread peers and recently seen authors, with no cell
 * filter, so a friend's post in any cell still arrives after a
 * replay miss. Bounded to 30 authors and the last 24 h by the
 * transport. Returns true when a query reached a relay.
 */
export async function runAuthorCatchUp(): Promise<boolean> {
  if (!hybrid?.nostr.online) return false;
  const authors = new Set<string>(recentAuthorHexes);
  try {
    const svc = await getDmService();
    for (const peerHex of await svc.listConversationPeers()) authors.add(peerHex);
  } catch {
    // DM peers are best-effort: the recent-authors set still stands.
  }
  if (authors.size === 0) return false;
  const sinceSec = Math.floor(Date.now() / 1000) - 86400;
  let sent = false;
  try {
    sent = await hybrid.nostr.catchUpAuthors([...authors], sinceSec);
  } catch {
    sent = false;
  }
  if (sent) recordServiceEvent(`relay author catch-up ${authors.size} authors`);
  return sent;
}

/**
 * Relay pool watchdog (v0.1.31): the outside push for a pool that
 * died with no trigger. Fires only when 0 relay sockets are open, no
 * reconnect is pending, and no connect was attempted for at least the
 * reconnect cap: a live ladder is never bypassed, and a dead network
 * gets at most one forced probe per minute. Logs its reason plus a
 * health snapshot, like every other recovery decision.
 */
function runRelayPoolWatchdog(): void {
  if (!hybrid) return;
  const nostr = hybrid.nostr;
  if (nostr.openRelayCount() > 0) return;
  if (nostr.pendingReconnectCount() > 0) return;
  if (Date.now() - nostr.getLastConnectAttemptMs() < POOL_WATCHDOG_STALE_MS) return;
  recordServiceEvent(
    `relay pool watchdog: 0 open relays, no reconnect pending, last attempt over ${POOL_WATCHDOG_STALE_MS / 1000}s ago, forcing reconnect attempt | ${healthSummary(buildTransportHealth())}`,
  );
  nostr.startIfNeeded();
}

/**
 * One health-change pass: drain the post outbox over BLE, flush the
 * DM outbox, run a WorldSync pass, and run author catch-up. Every
 * step is a no-op when nothing is queued or the path is down, and a
 * step failure never blocks the rest. Logs a line only when a
 * re-attempt actually moved something, so a quiet recovery does not
 * spam the log; the resubscribe / connectivity lines already prove
 * the socket or peer came back.
 */
async function runBalancerHealthPass(reason: string): Promise<void> {
  const drained = await drainPostOutbox().catch(() => 0);
  await flushDmOutboxIfStarted(true).catch(() => {});
  await runSync().catch(() => {});
  const caughtUp = await runAuthorCatchUp().catch(() => false);
  if (drained > 0 || caughtUp) {
    recordServiceEvent(
      `balancer health changed: ${reason} | drained ${drained} posts, author catch-up ${caughtUp ? 'sent' : 'skipped'} | ${healthSummary(buildTransportHealth())}`,
    );
  }
}

/**
 * Notify the balancer that transport health changed: peer connects,
 * relay recovers, network validates, backoff expires, app returns
 * to foreground. Re-attempts queued work once per change; concurrent
 * callers coalesce into one pass, with at most one follow-up pass
 * for changes that landed mid-pass. Never throws.
 */
export function notifyTransportHealthChanged(reason: string): Promise<void> {
  if (balancerHealthRun) {
    balancerHealthPending = true;
    return balancerHealthRun;
  }
  balancerHealthRun = (async () => {
    try {
      do {
        balancerHealthPending = false;
        await runBalancerHealthPass(reason);
      } while (balancerHealthPending);
    } catch {
      // Health re-attempts are best-effort; a failure here must never
      // break the caller (mesh poll, connectivity, foreground).
    }
  })();
  const run = balancerHealthRun;
  return run.finally(() => {
    if (balancerHealthRun === run) balancerHealthRun = null;
  });
}

/** Subscribe the transport to native adapter-state events from the port. */
function registerAdapterStateListener(): void {
  const port = blePort?.port as GattBlePort | null | undefined;
  if (!port || typeof port.onAdapterState !== 'function') return;
  port.onAdapterState((state) => {
    if (state === 'off') {
      // Powered-off: the one-time bring-up mirror is now wrong. Set
      // unavailable plus stopped events; powered-on below re-runs bring-up.
      if (bleRadioState === 'on') {
        recordScanStopped();
        recordAdvertiseStopped();
        bleRadioState = 'unavailable';
        syncDiagnosticsAdapterState();
      }
    } else if (state === 'on' && (radioWasOn || bleRadioState === 'unavailable') && bleRadioState !== 'on') {
      // Adapter powered on after being off: re-run bring-up. The
      // 'unavailable' arm is v0.1.31: a radio left unavailable by an
      // advertise failure at startup must recover on the adapter-on
      // event, not only when the radio was previously on.
      void revalidateBleRadio();
    }
  });
}

/**
 * Re-validate the radio on foreground (AppState active) and on
 * adapter-powered-on. When the radio is on, a missing grant or a
 * powered-off adapter reclassifies it; when it is not on, a live
 * adapter plus grants re-runs bring-up. A radio that failed to come
 * up at startup (state 'unavailable', e.g. an advertise failure)
 * is retried here too (v0.1.31): the old guard refused every retry
 * when radioWasOn was false, so the radio stayed dark until a
 * restart. The permission check below still runs first, so a
 * genuinely ungranted radio is reclassified, never brought up.
 * Never throws.
 */
export async function revalidateBleRadio(): Promise<void> {
  if (!hybrid || !blePort) return;
  if (bleRadioState === 'starting') return;
  try {
    // Permission revocation mid-session: grants can vanish while the app
    // is backgrounded, and a grant made in Settings is only picked up on
    // next launch without this check. Re-check here: missing grants tear
    // the radio down to permission-blocked, present grants allow bring-up.
    if (!(await checkBlePermissions().catch(() => false))) {
      if (bleRadioState === 'on') await tearDownBleRadio();
      bleRadioState = 'permission-blocked';
      syncDiagnosticsAdapterState();
      return;
    }
    const port = blePort.port as GattBlePort;
    const adapterState = typeof port.checkAdapterState === 'function' ? await port.checkAdapterState() : null;
    if (adapterState === 'off') {
      if (bleRadioState === 'on') {
        recordScanStopped();
        recordAdvertiseStopped();
      }
      bleRadioState = 'unavailable';
      syncDiagnosticsAdapterState();
      return;
    }
    if (bleRadioState !== 'on') {
      // A bring-up already running elsewhere wins: await it instead of
      // tearing it down mid-flight, then re-check the state it left.
      // Read through the getter: the narrowed local type cannot see
      // the state change the awaited bring-up made.
      if (bringUpPromise) {
        await bringUpPromise.catch(() => {});
        if (getBleRadioState() === 'on') return;
      }
      const publicKey = await getDevicePublicKey();
      await tearDownBleRadio();
      await bringUpBleRadio(toHex(publicKey));
      bleRadioState = 'on';
      radioWasOn = true;
      syncDiagnosticsAdapterState();
    } else if (!bleScanUp) {
      // Radio reports on but scanning is down (scan failure with
      // advertising up): re-run bring-up without tearing advertising
      // down. advertise() is idempotent for the same peer id, so this
      // only re-attempts the scan.
      const publicKey = await getDevicePublicKey();
      await bringUpBleRadio(toHex(publicKey));
    }
  } catch {
    // A failed revalidation leaves the radio unavailable, not wedged.
    if (bleRadioState !== 'on') {
      bleRadioState = 'unavailable';
      syncDiagnosticsAdapterState();
    }
  }
  // Foreground return with a live radio is a drain moment: peers may
  // have arrived while backgrounded, and the mesh poll edge only
  // fires on a 0 to N change it observed while running. One balancer
  // pass covers the drain, the DM flush, the sync pass, and author
  // catch-up together.
  if (bleRadioState === 'on') void notifyTransportHealthChanged('foreground revalidation').catch(() => {});
}

/**
 * Start the hybrid transport. Idempotent. Call once at app launch.
 * BLE runs always; Nostr follows connectivity.
 *
 * Defensive by design: a transport failure must never take the app down.
 * A half-started transport is torn down so a later call can retry, and the
 * feed keeps working offline regardless.
 */
export async function startTransport(): Promise<void> {
  if (hybrid) return;

  blePort = makeBlePort();
  registerAdapterStateListener();
  // DM mesh transport rides this same port (flags-1 DM frames, separate
  // from feed frames). Registration is idempotent: a later service
  // creation picks the port up, and a live service re-attaches at once.
  registerDmBlePort(blePort.port);
  // BLE ingress verifies signatures, matching the Nostr path (T11 §23.6):
  // an unsigned/tampered event from a mesh peer never reaches the store.
  const ble = new BleTransport(blePort.port, {
    verify: (event) => verifyEvent(crypto, event),
    onDedupDrop: (peerId) => recordDedupDrop(peerId),
    // A flood forward used to move a post with no message-level line:
    // only frame counters showed it. Log each forward as its own
    // outbound line, so a bridge phone's log traces the post onward.
    onFloodForward: (event, peerCount, ttl) => {
      recordMessage({
        id: toHex(event.id),
        sequence: postSeqOf(event),
        sizeBytes: encodeEvent(event).length,
        direction: 'outbound',
        kind: messageKindForEventKind(event.kind),
        attempts: [
          {
            transport: 'ble',
            atMs: Date.now(),
            outcome: 'ok',
            detail: `flood forward ${peerCount} peers ttl ${ttl}`,
          },
        ],
        finalStatus: 'forwarded via BLE',
      });
    },
  });
  // Relay list is user-configurable in Settings > Relays and persisted in
  // AsyncStorage (src/lib/relays.ts). loadRelayUrls() already falls back to
  // the default public relays when nothing is stored - and never throws -
  // so a storage failure here just means the defaults, never a dead uplink.
  hybrid = new HybridTransport(
    ble,
    {
      relays: await loadRelayUrls(),
      // This list is the user's explicit Settings list, so a private
      // relay the user added on purpose is allowed through here; the
      // package default (no flag) still drops private targets.
      allowPrivateRelays: true,
      // Relay frames that used to vanish: NOTICEs/CLOSEDs land in the
      // diagnostics breadcrumb trail, and an AUTH challenge is surfaced
      // there too (the client does not answer NIP-42 challenges yet).
      onRelayNotice: (relayUrl, frame, message) => {
        addBreadcrumb(`relay ${frame} ${relayUrl}`, { message });
      },
      onAuthChallenge: (relayUrl, challenge) => {
        addBreadcrumb(`relay AUTH challenge ${relayUrl}`, { challenge });
      },
      // Socket lifecycle lines (v0.1.31): a pool that tries and fails
      // used to leave no line at all, so the v0.1.30 window showed 4
      // minutes of relay silence with no reason. Every failure, close,
      // and scheduled reconnect now logs its relay URL and reason, so
      // the next log says whether the pool tried, failed, or never ran.
      onConnectFailure: (relayUrl, reason) => {
        recordServiceEvent(`relay connect failed ${relayUrl} ${reason}`);
      },
      onSocketClosed: (relayUrl, reason) => {
        recordServiceEvent(`relay socket closed ${relayUrl} ${reason}`);
      },
      onReconnectScheduled: (relayUrl, delayMs, attempt) => {
        recordServiceEvent(`relay reconnect in ${delayMs}ms ${relayUrl} attempt ${attempt}`);
      },
      // Replay window proof for testing: every resubscribe logs the
      // `since` it used, the relay it used it for, and whether the
      // window came from the last event actually seen on that relay
      // ('anchor') or from the 24 h cap ('cap'). Unix seconds and a
      // relay URL only, never content. A socket opening is also a
      // relay recovery, so it triggers a balancer health pass (queued
      // posts and DMs re-attempt, author catch-up runs).
      onResubscribe: (sinceSec, relayUrl, source) => {
        recordServiceEvent(`relay resubscribe since ${sinceSec} ${relayUrl} ${source}`);
        void notifyTransportHealthChanged('relay socket opened');
      },
    },
    {
      onDedupDrop: (_source, peerId) => recordDedupDrop(peerId),
    },
    {
      relayDeadlineMs: 5000,
      // R4: the router runs the relay stage only when the network is
      // not positively offline. A positive offline signal skips the
      // relay wait and falls through at once; unknown (no connectivity
      // state yet, or no NetInfo module) still routes on the live
      // socket fact, so builds without NetInfo keep relay working.
      networkValidated: () => lastOnline !== false,
      // Rank 14, dead-hotspot deadline. Why unknown cannot be resolved
      // faster from code: NetInfo reports isInternetReachable as null
      // until its own reachability check lands, and it offers no
      // synchronous reachability query; the first listener fire or
      // fetch resolution is the earliest signal the app can get. The
      // app already maps that null to offline (wireConnectivity uses
      // !!isInternetReachable), so a null never lingers as unknown in
      // lastOnline: with the module loaded, a dead hotspot resolves
      // reachability false, the sockets stop, and the relay stage is
      // skipped at once with no deadline burn at all. The residual
      // unknown window is pre-first-state (and module-missing, where
      // no state ever arrives); a publish in that window runs on the
      // live socket fact with the shortened 1500 ms deadline instead
      // of the full 5000 ms, so a dead upstream cannot stall mesh
      // fallback for the full deadline. The actual null window on a
      // real dead hotspot still needs a device measurement (see the
      // phone checks): the platform may resolve it faster or slower
      // than the app can observe, and code cannot distinguish that.
      // A half-open socket while the network is known online is a
      // separate case and still burns the full deadline; that is the
      // silence-timer problem, not this rank.
      networkUnknown: () => !connectivityKnown,
      unknownNetworkDeadlineMs: 1500,
      // Rank 5, World honesty: every relay-sourced event at ingress,
      // including duplicates dropped by the seen cache, confirms
      // World. A post this phone published is in the seen cache from
      // publish time, so a relay query hit returning it is a duplicate
      // by id by definition; without this hook that hit would be
      // swallowed and a query-hit confirmation could never fire for
      // own posts in the same launch. BLE observations never confirm.
      onRelayObserved: (event) => {
        void getStore()
          .markWorldConfirmed(toHex(event.id))
          .catch(() => {});
      },
    },
  );
  if (pendingSubscribeCells) {
    hybrid.nostr.setSubscribeCells(pendingSubscribeCells);
    pendingSubscribeCells = null;
  }
  sync = new WorldSync(
    hybrid.nostr,
    {
      markWorldConfirmed: (id: Hex64) => getStore().markWorldConfirmed(id),
      isWorldConfirmed: (id: Hex64) => getStore().isWorldConfirmed(id),
      getUnconfirmed: () => getStore().getUnconfirmed(),
      getEvent: (id: Hex64) => getStore().getEvent(id),
    } satisfies WorldConfirmStore,
    {
      // A sync re-push used to leave no line, so a post recovered by
      // WorldSync (like the v0.1.23 163B post, seen only as an inbound
      // line on the peer) was invisible on the sender's log. Log each
      // pushed event as its own relay line, distinct from the
      // publish-time relay line, so a recovery is traceable.
      onPushed: (events) => {
        for (const event of events) {
          recordMessage({
            id: toHex(event.id),
            sequence: postSeqOf(event),
            sizeBytes: encodeEvent(event).length,
            direction: 'outbound',
            kind: messageKindForEventKind(event.kind),
            attempts: [
              {
                transport: 'relay',
                atMs: Date.now(),
                outcome: 'ok',
                detail: 'sync push relay OK',
              },
            ],
            finalStatus: 'relayed via sync',
          });
        }
      },
    },
  );

  // Relay-observed posts are, by definition, on World: confirmListener marks
  // them confirmed so the feed's globe icon lights up. Inbound posts still
  // flow through the same store path as before.
  hybrid.onPost(
    sync.confirmListener((event, source) => {
      // Never drop a storage failure silently: a rejected handleIncoming
      // used to vanish (relay ingress is fire-and-forget), so a lost post
      // left no trace. Log it; the next relay pass can re-deliver it.
      void handleIncoming(event, source).catch((e) => {
        console.error('handleIncoming failed:', e);
      });
    }),
  );

  try {
    await hybrid.start();
  } catch {
    // Never leave a half-started transport behind: reset module state so a
    // later startTransport() can retry cleanly. The app runs offline-only.
    // The failure is surfaced, not swallowed: a Diagnostics line plus the
    // failed flag the mesh pill reads (offline, never mesh).
    transportStartFailed = true;
    recordTransportFailure('start');
    await blePort?.close();
    blePort = null;
    registerDmBlePort(null);
    hybrid = null;
    sync = null;
    lastOnline = null;
    throw new Error('transport failed to start; running offline-only');
  }

  // T19: rebuild reshare counts from stored kind-5 events before the feed
  // first renders them. Best-effort and idempotent: a failure just means
  // counts repopulate as reshare events re-arrive via flood/relay.
  try {
    const restored = await rehydrateReshares();
    if (restored > 0) notifyFeedListeners();
  } catch {
    // Never fail launch on a counter rebuild.
  }

  // Bring up the BLE radio only when the OS grants are already in place.
  // The OS permission dialog NEVER fires here: permission priming (the app's
  // own rationale UI first, OS request only on the user's action) is owned
  // by the BlePrime UI. A missing grant just leaves the radio down - the
  // mesh runs Nostr-only, exactly like the old no-op port behaved.
  if (await checkBlePermissions().catch(() => false)) {
    try {
      const publicKey = await getDevicePublicKey();
      await bringUpBleRadio(toHex(publicKey));
      bleRadioState = 'on';
      radioWasOn = true;
    } catch {
      // R3: do not conflate a permission loss between the check and the
      // bring-up (or a permanently denied grant) with a dead radio.
      // Re-check: missing grants mean permission-blocked (the priming
      // and Diagnostics Settings flows own the next step); only a
      // granted-but-failed bring-up is unavailable. Previously every
      // failure landed as unavailable, hiding the permission path.
      await tearDownBleRadio();
      bleRadioState = (await checkBlePermissions().catch(() => false)) ? 'unavailable' : 'permission-blocked';
    }
  } else {
    bleRadioState = 'permission-blocked';
  }
  syncDiagnosticsAdapterState();

  try {
    wireConnectivity();
  } catch {
    // NetInfo listener registration blew up after a successful load:
    // fall back to offline-only (BLE stub), nostr stays as started.
    netUnsub?.();
    netUnsub = null;
  }

  // Relay pool watchdog (v0.1.31): a pool that dies with no trigger
  // gets an outside push every 15 s (bounded to one forced probe per
  // minute by the staleness check inside). Cleared in stopTransport.
  if (!poolWatchdogTimer) {
    poolWatchdogTimer = setInterval(() => runRelayPoolWatchdog(), POOL_WATCHDOG_INTERVAL_MS);
  }

  transportStartFailed = false;
  // Startup retention cleanup (best-effort, never fails launch). This is
  // the first prune a long-lived install has ever run, so it deletes
  // rows past the designed 24 h window on first launch after this change.
  await pruneExpiredStore();
  // Startup outbox drain: a post queued before a kill or relaunch
  // gets its BLE re-send now if peers are already connected; otherwise
  // the mesh poll edge catches the next peer arrival.
  void drainPostOutbox().catch(() => {});
}

/** Clear any pending scan retry timer and reset the backoff. Never throws. */
function clearScanRetry(): void {
  if (scanRetryTimer) {
    clearTimeout(scanRetryTimer);
    scanRetryTimer = null;
  }
  scanRetryAttempt = 0;
}

/** Clear any pending advertise retry timer and reset the backoff. Never throws. */
function clearAdvertiseRetry(): void {
  if (advertiseRetryTimer) {
    clearTimeout(advertiseRetryTimer);
    advertiseRetryTimer = null;
  }
  advertiseRetryAttempt = 0;
}

/**
 * Schedule one more advertise attempt after an advertise failure,
 * with backoff. At most one timer is ever pending, and an exhausted
 * backoff simply stops: foreground re-validation, adapter-on events,
 * and manual Retry remain as recovery paths. Only advertise is
 * re-attempted here, never the whole bring-up: scan may already be
 * running, and a second bring-up would double-start it.
 */
function scheduleAdvertiseRetry(peerIdHex: string): void {
  if (advertiseRetryTimer || advertiseRetryAttempt >= ADVERTISE_RETRY_DELAYS_MS.length) return;
  const delay = ADVERTISE_RETRY_DELAYS_MS[advertiseRetryAttempt++];
  advertiseRetryTimer = setTimeout(
    () =>
      (async () => {
        advertiseRetryTimer = null;
        if (!blePort || !hybrid) return;
        try {
          await blePort.port.advertise(peerIdHex);
          // Advertise recovered: the radio is whole again. If the
          // failed bring-up had left the state unavailable, lift it.
          if (bleRadioState === 'unavailable') {
            bleRadioState = 'on';
            radioWasOn = true;
            syncDiagnosticsAdapterState();
          }
          recordServiceEvent('advertise recovered after retry');
          advertiseRetryAttempt = 0;
        } catch (err) {
          // Still failing (Bluetooth still enabling, or a real
          // peripheral loss): log the reason and schedule the next
          // attempt while any remain.
          recordServiceEvent(
            `advertise retry failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          scheduleAdvertiseRetry(peerIdHex);
        }
      })(),
    delay,
  );
}

/**
 * Schedule one more bring-up attempt after a scan failure, with
 * backoff. At most one timer is ever pending, and an exhausted
 * backoff simply stops: foreground re-validation, adapter-on events,
 * and manual Retry remain as recovery paths.
 */
function scheduleScanRetry(): void {
  if (scanRetryTimer || scanRetryAttempt >= SCAN_RETRY_DELAYS_MS.length) return;
  const delay = SCAN_RETRY_DELAYS_MS[scanRetryAttempt++];
  scanRetryTimer = setTimeout(
    () =>
      (async () => {
        scanRetryTimer = null;
        if (!blePort || !hybrid) return;
        try {
          const publicKey = await getDevicePublicKey();
          await bringUpBleRadio(toHex(publicKey));
        } catch {
          // Advertise failed on retry: the radio is genuinely down.
          // Leave reclassification to the next foreground re-validation
          // or manual Retry; do not schedule further retries here.
          bleScanUp = false;
        }
      })(),
    delay,
  );
}

/**
 * Advertise our identity and scan for mesh peers. Throws only when
 * the port is not constructed. An advertise failure does NOT throw
 * (v0.1.31): the phone can still scan and central-connect as a
 * client, and the advertise retry timer re-attempts with backoff.
 * Concurrent callers join the in-flight bring-up instead of racing
 * it (mesh-scan fix): without this, two bring-ups at startup each
 * ran the native scan and the logs showed double scan started lines.
 */
async function bringUpBleRadio(peerIdHex: string): Promise<void> {
  if (bringUpPromise) return bringUpPromise;
  bringUpPromise = bringUpBleRadioInner(peerIdHex).finally(() => {
    bringUpPromise = null;
  });
  return bringUpPromise;
}

/**
 * Bring-up body. A scan failure does NOT throw here (mesh-scan fix):
 * advertising is up, so the phone stays discoverable, and scanning
 * recovers via the retry timer. The old code threw on scan failure
 * and every caller tore the radio down, which also stopped
 * advertising: one scan timeout left the phone mute and deaf until
 * relaunch, and since the radio never reached 'on', foreground
 * re-validation refused to retry it (radioWasOn stayed false).
 * An advertise failure does NOT throw either (v0.1.31): the scan
 * still starts, so the phone can discover peers and connect as a
 * client while the advertise retry timer re-attempts with backoff.
 * Callers still mark the radio 'on' after this resolves: 'on' means
 * the radio is up (scanning, advertising up or retrying); live scan
 * health is in diagnostics (scanning state plus last failure) and in
 * bleScanUp, and the advertising state is tracked separately there.
 */
async function bringUpBleRadioInner(peerIdHex: string): Promise<void> {
  if (!blePort) throw new Error('ble: port not constructed');
  try {
    await blePort.port.advertise(peerIdHex);
  } catch (err) {
    // Advertise failed at startup (v0.1.30: "Not support
    // bluetoothLeAdvertiser" on both phones, then fine on the next
    // restart): a startup race or Bluetooth still enabling. Do not
    // throw: the phone can still scan and central-connect, and the
    // retry timer re-attempts advertise with backoff. The old code
    // threw here and every caller tore the radio down to
    // 'unavailable' with no recovery except a restart.
    recordServiceEvent(
      `advertise failed, retry scheduled: ${err instanceof Error ? err.message : String(err)}`,
    );
    scheduleAdvertiseRetry(peerIdHex);
  }
  try {
    bleScanUnsub = await blePort.port.scan(() => {
      // Peer registry for future UI (MeshStatus); discovery itself drives
      // the port's auto-connect. Nothing to do per peer in v1.
    });
    bleScanUp = true;
    clearScanRetry();
  } catch {
    // Scan failed, advertising stands. The port already recorded the
    // scan failure in diagnostics. Return normally so callers do not
    // tear advertising down; schedule a scan retry with backoff.
    bleScanUp = false;
    scheduleScanRetry();
  }
}

/** Tear down whatever half of the radio bring-up succeeded. Never throws. */
async function tearDownBleRadio(): Promise<void> {
  clearScanRetry();
  clearAdvertiseRetry();
  bleScanUp = false;
  try {
    bleScanUnsub?.();
  } catch {
    // ignore
  }
  bleScanUnsub = null;
  await blePort?.port.stopAdvertise().catch(() => {});
}

/** The BLE radio state for the priming UI. */
export function getBleRadioState(): BleRadioState {
  return bleRadioState;
}

/**
 * BLE peer ids that can receive a broadcast right now: established
 * connections only (identity resolved). Ports without the optional
 * connectedPeerIds() method contribute nothing. Never throws.
 */
export function blePeerIdsForPublish(port: TransportPort | null | undefined): string[] {
  // Ready peers only (v0.1.31): a peer whose handshake is still in
  // flight cannot receive a notify yet, so it is not a publish,
  // drain, or mesh-pill target. Sending to it counts as sent while
  // landing nowhere (v0.1.30 B drain at 03:28:05). Ports without
  // readiness fall back to connected peers; a throwing readiness
  // probe falls back the same way instead of returning nothing.
  try {
    const ready = port?.readyPeerIds?.();
    if (ready) return ready;
  } catch {
    // fall through to connected peers
  }
  try {
    return port?.connectedPeerIds?.() ?? [];
  } catch {
    return [];
  }
}

/** Mesh pill state: linked neighbours + what the app is actually syncing over. */
export interface MeshStatusSnapshot {
  /** Established BLE connections (linked neighbours - not merely heard ads). */
  peersNearby: number;
  /** 'mesh' = BLE radio only, 'online' = internet up (World visible), 'offline' = neither. */
  relayState: 'mesh' | 'online' | 'offline';
}

/**
 * Pure relay-state mapping (unit-tested truth table). 'starting' maps to
 * 'mesh' so the pill keeps its boot appearance until a real state is known;
 * a permission-blocked/unavailable radio with Nostr online shows 'online'
 * (truthful: syncing over the internet, NOT the mesh) instead of the old
 * hardcoded 'mesh only' lie. A failed transport start maps to 'offline'
 * even while the radio state still reads 'starting': claiming mesh with
 * no transport at all was the swallowed-failure lie.
 */
export function resolveRelayState(
  nostrOnline: boolean,
  bleState: BleRadioState,
  transportFailed = false,
): MeshStatusSnapshot['relayState'] {
  if (transportFailed) return 'offline';
  if (nostrOnline) return 'online';
  if (bleState === 'on' || bleState === 'starting') return 'mesh';
  return 'offline';
}

let meshSnapshot: MeshStatusSnapshot = { peersNearby: 0, relayState: 'mesh' };

/**
 * Current mesh status snapshot. Returns a cached reference that only
 * changes when a value changes (required by useSyncExternalStore).
 */
export function getMeshStatus(): MeshStatusSnapshot {
  const next: MeshStatusSnapshot = {
    peersNearby: blePeerIdsForPublish(blePort?.port).length,
    relayState: resolveRelayState(!!hybrid?.nostr.online, bleRadioState, transportStartFailed),
  };
  if (next.peersNearby !== meshSnapshot.peersNearby || next.relayState !== meshSnapshot.relayState) {
    meshSnapshot = next;
  }
  return meshSnapshot;
}

/**
 * Subscribe to mesh-status changes. Polls every 2s and fires only on real
 * change; the port emits no connect/disconnect events, so polling is the
 * honest mechanism (not a second event system). Returns unsubscribe.
 */
/** Connected-peer count at the last mesh-status poll (peer-arrival edge). */
let prevMeshPeers = 0;
/** DM relay open-socket count at the last mesh-status poll. */
let prevDmOpenRelays = 0;

export function subscribeMeshStatus(cb: () => void): () => void {
  const timer = setInterval(() => {
    const before = meshSnapshot;
    const next = getMeshStatus();
    if (next !== before) cb();
    // BLE peer arrival is a transport return: a queued DM drains over
    // mesh now, not when its backoff timer would fire, and a post
    // queued with no peers gets its BLE re-send when a peer nears,
    // without waiting for internet. Edge-triggered (0 to N) so a
    // steady peer set does not re-flush every poll and burn outbox
    // attempts. One balancer pass covers the drain, the DM flush, the
    // sync pass, and author catch-up together.
    if (prevMeshPeers === 0 && next.peersNearby > 0) {
      void notifyTransportHealthChanged('ble peer arrived').catch(() => {});
    }
    prevMeshPeers = next.peersNearby;
    // DM pool recovery is a transport return too (v0.1.31): the DM
    // pool recovered at 03:26:41 while the post pool stayed dead, and
    // no balancer line covered it. A rise in the DM open count
    // re-attempts queued posts the same way a BLE peer arrival does.
    // The DM pool is also the faster recovery signal: its resubscribe
    // clears its backoff on validation, so it can open while NetInfo
    // still says offline. When it opens while the post pool is still
    // dead, re-attempt the post pool at once instead of waiting out
    // its backoff ladder (v0.1.32).
    const dmOpen = getDmRelayPoolHealth()?.openUrls.length ?? 0;
    if (dmOpen > prevDmOpenRelays) {
      void notifyTransportHealthChanged('dm relay socket opened').catch(() => {});
      if ((hybrid?.nostr.openRelayCount() ?? 0) === 0) hybrid?.nostr.reconnectNow();
    }
    prevDmOpenRelays = dmOpen;
  }, 2000);
  return () => clearInterval(timer);
}

/**
 * Priming-aware radio enable. Call ONLY from the user's explicit action
 * (the BlePrime dialog's Enable button): fires the real OS permission
 * request, then brings up the radio on grant. Returns true when the radio
 * is up. Never throws.
 */
export async function enableBleRadio(): Promise<boolean> {
  if (bleRadioState === 'on') return true;
  try {
    if (!(await requestBlePermissions())) return false;
    const publicKey = await getDevicePublicKey();
    await bringUpBleRadio(toHex(publicKey));
    bleRadioState = 'on';
    radioWasOn = true;
    syncDiagnosticsAdapterState();
    return true;
  } catch {
    // Same R3 classification as startTransport: a failed bring-up with
    // grants still missing (permanently denied is the common case: the
    // OS request returns denied without showing a dialog) stays
    // permission-blocked, so Diagnostics keeps offering Open Settings
    // instead of reporting a dead radio.
    bleRadioState = (await checkBlePermissions().catch(() => false)) ? 'unavailable' : 'permission-blocked';
    syncDiagnosticsAdapterState();
    return false;
  }
}

/**
 * Diagnostics Retry Bluetooth: the force path. Normal priming is
 * idempotent by design (same peerId early return, existing scan skipped),
 * which makes Retry a no-op in exactly the broken-radio cases it should
 * fix: a held-but-dead adapter, a natively dead scan, or a null port.
 * So Retry tears down scan and advertise first, clears the scan
 * unsubscribe, and brings the radio up again with no state-on early
 * return; a null port is recreated instead of throwing. Never throws.
 */
export async function retryBleRadio(): Promise<boolean> {
  try {
    if (!blePort) {
      blePort = makeBlePort();
      registerAdapterStateListener();
      registerDmBlePort(blePort.port);
    }
    await tearDownBleRadio();
    if (!(await requestBlePermissions())) {
      bleRadioState = 'permission-blocked';
      syncDiagnosticsAdapterState();
      return false;
    }
    const publicKey = await getDevicePublicKey();
    await bringUpBleRadio(toHex(publicKey));
    bleRadioState = 'on';
    radioWasOn = true;
    syncDiagnosticsAdapterState();
    return true;
  } catch {
    bleRadioState = (await checkBlePermissions().catch(() => false)) ? 'unavailable' : 'permission-blocked';
    syncDiagnosticsAdapterState();
    return false;
  }
}

/**
 * Test seam: the live HybridTransport, or null before startTransport().
 * Lets tests drive ingress() through the real app wiring (e.g. verify a
 * relay-observed post gets World-confirmed).
 */
export function __getHybridForTests(): HybridTransport | null {
  return hybrid;
}

/** Test-only seam: replace the BLE port (transport tests drive bring-up without native modules). */
export function __setBlePortForTests(port: TransportPort | null): void {
  blePort = port ? { port, close: async () => {} } : null;
}

/**
 * Narrow the relay subscribe filter to the viewer's in-scope cells
 * (feed tab owns the current cells). The next reconnect subscribes with
 * the `#g` filter; until cells are known the filter stays global, so
 * coverage is never lost. Cells resolved before startTransport are
 * applied when the transport starts.
 */
let pendingSubscribeCells: string[] | null = null;

export function setRelaySubscribeCells(cells: string[]): void {
  if (hybrid) {
    hybrid.nostr.setSubscribeCells(cells);
  } else {
    pendingSubscribeCells = [...cells];
  }
}

/**
 * Apply one connectivity state to the transport. Single funnel for both
 * the NetInfo listener and the initial fetch, so both paths behave the
 * same: online (re)starts the relay sockets, runs a WorldSync pass, and
 * starts the periodic sync timer; offline stops the sync timer only.
 * BLE always runs (mesh works offline - that is the point of the app).
 *
 * The relay pool is deliberately NOT stopped on offline (v0.1.31).
 * NetInfo is a lagging oracle: in the v0.1.30 window it said unknown
 * for 2 minutes after a restart and not-validated while the DM relay
 * was already delivering, and its online verdict lagged the real
 * network return by about 2 minutes. The old code called
 * nostr.stop() here, which cancelled the reconnect ladder
 * (started=false, timers cleared) and left the pool dead with no
 * trigger until the next online event, 3 minutes later, with no log
 * line. The socket attempt itself is the probe now: a dead network
 * fails fast, the ladder backs off to its 60 s cap, and the pool
 * recovers the moment a socket actually opens. The DM pool already
 * worked this way (no NetInfo gate, connects on demand). Transitions
 * only: duplicates are no-ops.
 */
function applyConnectivity(online: boolean): void {
  if (online === lastOnline) return;
  lastOnline = online;
  connectivityKnown = true;
  if (online) {
    addBreadcrumb('transport: connectivity online');
    recordServiceEvent(`network validated (${lastNetInfoSummary ?? 'no NetInfo state yet'}) | ${healthSummary(buildTransportHealth())}`);
    // Immediate re-attempt for dead relays: reconnectNow clears any
    // pending backoff timer and connects now, instead of waiting out
    // the ladder (up to 60 s). startIfNeeded alone would skip every
    // relay with a timer pending, which is exactly the v0.1.31 lag:
    // validation 08:31:53, pool open only 08:32:10. The pool is never
    // stopped on offline anymore, so it is already started.
    hybrid?.nostr.reconnectNow();
    // Periodic sync while online.
    startSyncTimer();
    // A transport returning drains the DM queue and replays missed DMs
    // and acks: both are no-ops when the DM service was never started.
    // One balancer pass covers the DM flush, the sync pass, the post
    // drain, and author catch-up together.
    void notifyTransportHealthChanged('network validated').catch(() => {});
    void refreshDmSubscriptionIfStarted().catch(() => {});
  } else {
    addBreadcrumb('transport: connectivity offline');
    recordServiceEvent(
      `network not validated (${lastNetInfoSummary ?? 'no NetInfo state yet'}): relay pool keeps its reconnect ladder, sync timer stopped | ${healthSummary(buildTransportHealth())}`,
    );
    stopSyncTimer();
  }
}

/**
 * Drive Nostr from connectivity: start relays when online, stop them when
 * offline, and run the periodic World sync only while online. Separated
 * from startTransport() so the wiring is independently testable.
 */
function wireConnectivity(): void {
  const netInfo = getNetInfo();
  if (!netInfo) {
    // No connectivity module - run offline-only (BLE stub). Nostr stays
    // stopped; the feed works fine without it.
    return;
  }

  // React to connectivity changes.
  netUnsub = netInfo.addEventListener((state) => {
    lastNetInfoSummary = netInfoWords(state);
    applyConnectivity(!!state.isConnected && !!state.isInternetReachable);
  });

  // Initial state check (addEventListener also fires on subscribe, but the
  // explicit fetch covers mocks/listener quirks). A fetch rejection must
  // not surface as an unhandled rejection: the listener already covers
  // live transitions.
  void netInfo
    .fetch()
    .then((initial) => {
      lastNetInfoSummary = netInfoWords(initial);
      applyConnectivity(!!initial.isConnected && !!initial.isInternetReachable);
    })
    .catch(() => {});
}

/** Stop the transport. Call on app teardown (rarely needed on mobile). */
export async function stopTransport(): Promise<void> {
  if (feedNotifyTimer) {
    clearTimeout(feedNotifyTimer);
    feedNotifyTimer = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (poolWatchdogTimer) {
    clearInterval(poolWatchdogTimer);
    poolWatchdogTimer = null;
  }
  netUnsub?.();
  netUnsub = null;
  lastOnline = null;
  lastNetInfoSummary = null;
  connectivityKnown = false;
  clearScanRetry();
  clearAdvertiseRetry();
  bleScanUp = false;
  try {
    bleScanUnsub?.();
  } catch {
    // ignore
  }
  bleScanUnsub = null;
  await hybrid?.stop();
  await blePort?.close();
  blePort = null;
  registerDmBlePort(null);
  hybrid = null;
  sync = null;
  radioWasOn = false;
  transportStartFailed = false;
  bleRadioState = 'unavailable';
  syncDiagnosticsAdapterState();
}

/**
 * Drain the durable post outbox over BLE, oldest first.
 *
 * Runs on BLE peer arrival (see subscribeMeshStatus), at transport
 * start, and on foreground radio re-validation: exactly the moments
 * a new peer set may exist. Relay retry is deliberately NOT done
 * here: WorldSync owns relay retry on its 60 second tick and on
 * connectivity return, and a BLE drain while online would break the
 * relay-first order by sending over BLE first. This drain is the
 * offline path: queued own posts reach a peer that arrives later.
 *
 * Each row is re-checked against the store before sending (the event
 * may have expired or been World-confirmed since the row was listed),
 * and a missing event removes its row instead of stalling the drain.
 * A send marks the row 'ble-sent'; a send to connected peers that
 * completes on none marks it 'unsent'. No peers means no attempt at
 * all: the row waits for the next peer-arrival edge, not a timer.
 *
 * Handoff memory (v0.1.31): a row handed to a peer is not handed to
 * that same peer again inside DRAIN_HANDOFF_WINDOW_MS, so one health
 * trigger storm does not re-send the same rows to the same peer 3 to
 * 4 times (v0.1.30). A new ready peer still gets the row at once,
 * and a row still unconfirmed after the window re-attempts. Skips are
 * logged once per pass, not per row. Returns the count of rows sent
 * to at least one peer. Never throws.
 */
export async function drainPostOutbox(): Promise<number> {
  if (!hybrid) return 0;
  const peers = blePeerIdsForPublish(blePort?.port);
  if (peers.length === 0) return 0;
  const nowMs = Date.now();
  pruneDrainHandoffMemory(nowMs);
  let sentRows = 0;
  let attemptedRows = 0;
  let skippedRows = 0;
  const targetedPeers = new Set<string>();
  try {
    const store = getStore();
    const rows = await store.listPostOutbox();
    for (const row of rows) {
      const event = await store.getEvent(row.eventId).catch(() => null);
      if (!event) {
        await store.removePostOutbox(row.eventId).catch(() => {});
        continue;
      }
      if (await store.isWorldConfirmed(row.eventId).catch(() => false)) {
        await store.removePostOutbox(row.eventId).catch(() => {});
        continue;
      }
      // Only peers this row has not been handed to inside the window:
      // a row handed to every ready peer already waits for a new peer
      // or the window, instead of re-burning the same radio.
      const targets = drainTargetsForRow(row.eventId, peers, nowMs);
      if (targets.length === 0) {
        skippedRows += 1;
        continue;
      }
      // Pacing (v0.1.31): a short gap between rows, not one burst.
      // See DRAIN_ROW_DELAY_MS. Skipped rows do not consume a gap.
      if (attemptedRows > 0 && drainRowDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, drainRowDelayMs));
      }
      for (const peerId of targets) targetedPeers.add(peerId);
      const sent = await hybrid.sendOverMesh(event, targets).catch(() => 0);
      attemptedRows += 1;
      if (sent > 0) {
        sentRows += 1;
        recordDrainHandoff(row.eventId, targets, nowMs);
        await store.markPostOutboxAttempt(row.eventId, 'ble-sent').catch(() => {});
      } else {
        await store.markPostOutboxAttempt(row.eventId, 'unsent').catch(() => {});
      }
      // A drain send used to leave no line at all, so a redelivery (or
      // its failure) was invisible in the next log: the v0.1.23
      // regression could not tell whether the outbox had drained. Drain
      // rows are kind-1 posts by construction (only posts queue here).
      recordMessage({
        id: row.eventId,
        sequence: postSeqOf(event),
        sizeBytes: encodeEvent(event).length,
        direction: 'outbound',
        kind: 'post',
        attempts: [
          {
            transport: 'ble',
            atMs: Date.now(),
            outcome: sent > 0 ? 'ok' : 'failed',
            detail: sent > 0 ? `drain ble sent to ${sent} peers` : 'drain ble send failed',
          },
        ],
        finalStatus: sent > 0 ? 'handed to radio over BLE' : 'not delivered to any transport',
      });
    }
  } catch {
    // A drain failure must never break the caller (mesh poll, start,
    // or foreground): the rows stay queued for the next trigger.
  }
  // A skipped row is a decision, not silence: one line per pass says
  // how many rows were held back and why, so the next log can tell a
  // deduped drain from a dead radio.
  if (skippedRows > 0) {
    recordServiceEvent(
      `drain skipped ${skippedRows} rows handed to same peers within ${DRAIN_HANDOFF_WINDOW_MS / 1000}s | ${healthSummary(buildTransportHealth())}`,
    );
  }
  // Fold the drain outcome into per-peer BLE health, but only when a
  // send was actually attempted: an empty outbox says nothing about
  // the radio. A drain that reached nobody backs the targeted peers
  // off and arms one re-attempt at the backoff expiry.
  if (attemptedRows > 0) {
    armBalancerRetryTimer(noteBlePeerOutcome([...targetedPeers], sentRows));
  }
  if (sentRows > 0) notifyFeedListeners();
  return sentRows;
}

/** Ready peers this row has not been handed to inside the window. */
function drainTargetsForRow(eventId: string, readyPeers: string[], nowMs: number): string[] {
  const handed = drainHandoffByEvent.get(eventId);
  if (!handed || handed.size === 0) return [...readyPeers];
  return readyPeers.filter((peerId) => {
    const atMs = handed.get(peerId.slice(0, 8));
    return atMs === undefined || nowMs - atMs >= DRAIN_HANDOFF_WINDOW_MS;
  });
}

/** Record a handoff of one row to each target peer (by tag). */
function recordDrainHandoff(eventId: string, peerIds: string[], nowMs: number): void {
  let handed = drainHandoffByEvent.get(eventId);
  if (!handed) {
    handed = new Map<string, number>();
    drainHandoffByEvent.set(eventId, handed);
  }
  for (const peerId of peerIds) handed.set(peerId.slice(0, 8), nowMs);
  // Bounded: oldest rows drop when the map grows past the cap, so a
  // long session cannot grow this memory without bound.
  while (drainHandoffByEvent.size > DRAIN_HANDOFF_MAX_ROWS) {
    const oldest = drainHandoffByEvent.keys().next();
    if (oldest.done) break;
    drainHandoffByEvent.delete(oldest.value);
  }
}

/** Drop handoff entries older than the window, and empty rows. */
function pruneDrainHandoffMemory(nowMs: number): void {
  for (const [eventId, handed] of [...drainHandoffByEvent]) {
    for (const [tag, atMs] of [...handed]) {
      if (nowMs - atMs >= DRAIN_HANDOFF_WINDOW_MS) handed.delete(tag);
    }
    if (handed.size === 0) drainHandoffByEvent.delete(eventId);
  }
}

/** Publish a local event through the ordered router (R4). */
export async function publishViaTransport(event: SignedEvent): Promise<RouteResult> {
  if (!hybrid) await startTransport();
  // BLE fan-out targets the currently connected peers. Previously this
  // call passed no peer ids at all, so local posts NEVER went out over
  // BLE - only Nostr - even with phones connected over GATT.
  const blePeersAtPublish = blePeerIdsForPublish(blePort?.port);
  // Balancer plan (v0.1.27): route from live health, and log the
  // decision with its reason and a health snapshot. A BLE set that
  // just failed is not re-hammered: its peers are held out of this
  // send until the backoff window ends, and the retry timer re-attempts
  // then. Relay viability is advisory here: the router re-checks the
  // live socket fact itself before waiting on any relay deadline.
  const health = buildTransportHealth();
  const plan = planSend(health);
  recordServiceEvent(
    `balancer route ${plan.paths.join('+') || 'queue'} | ${plan.detail}${plan.queuedReason ? ` | ${plan.queuedReason}` : ''} | ${healthSummary(health)}`,
  );
  // Per-peer routing (v0.1.31): the plan's BLE leg is viable when ANY
  // ready peer is healthy, but the router only gets the healthy ones.
  // A peer serving a backoff after failed sends is held out of this
  // send alone; the others still get the post in the same publish,
  // so one BLE-only peer, one mobile-only peer, and one Wi-Fi-only
  // peer are all served by the path each can actually use.
  const healthyTags = new Set(
    health.peers.filter((p) => isPeerHealthy(p, health.nowMs)).map((p) => p.tag),
  );
  const blePeersForRouter = plan.paths.includes('ble')
    ? blePeersAtPublish.filter((peerId) => healthyTags.has(peerId.slice(0, 8)))
    : [];
  const bleFilteredByBackoff = blePeersAtPublish.length > 0 && blePeersForRouter.length === 0;
  const result = await hybrid!.publish(event, blePeersForRouter);
  // Fold the outcome back into health: a real relay rejection backs
  // that relay off (duplicate counts as stored, never a failure),
  // and a BLE broadcast that reached nobody backs the targeted peers
  // off. Both arm one re-attempt timer at the nearest expiry.
  const backoffUntil = noteBalancerRelayResult(result);
  armBalancerRetryTimer(backoffUntil);
  // Only an attempted BLE leg feeds the per-peer health: a send held
  // out by backoff must not re-arm the backoff it is already serving.
  if (blePeersForRouter.length > 0) {
    armBalancerRetryTimer(noteBlePeerOutcome(blePeersForRouter, result.blePeers));
  }
  // Rank 5, World honesty: a direct relay OK no longer confirms World
  // at once. A relay can OK an envelope and then drop it before any
  // peer fetches it, and the old code left the sender showing the
  // globe for a post no relay holds. World now sets only when the post
  // is observed back from a relay: either a subscription replay or a
  // WorldSync query hit (see onRelayObserved in startTransport, which
  // fires even for seen-cache duplicates, and confirmListener for
  // first-time relay arrivals). The accepted cost is honest: the globe
  // appears one query round trip later instead of instantly on OK.
  // So the round trip does not wait up to 60 s for the next timer
  // tick, a relay win for a post triggers one WorldSync pass here:
  // the pass re-pushes the still-unconfirmed post and queries for it,
  // and the query hit confirms it only if a relay still holds it. A
  // relay that dropped the event before the query yields no hit, no
  // globe, and the post stays unconfirmed for later passes to re-push.
  if (result.transport === 'relay' && event.kind === EVENT_KIND_POST) {
    void runSync();
  }
  // Outbox status follows the router result, for kind-1 posts only
  // (stars and reshares also flow through this router, but they are
  // not outbox posts). A relay win KEEPS the row as 'ble-sent'
  // (v0.1.27): removing it on relay win left a peer arriving after
  // publish with no Bluetooth copy, and the sender had no path left
  // to reach it. The row is removed only once the post is
  // World-confirmed (see drainPostOutbox), so a late peer still gets
  // the post over BLE via the drain, and a relay-OK'd post the
  // receiver never fetched still has a sender-side copy to re-push.
  // A mesh send keeps the row as 'ble-sent' (still awaiting World);
  // a queued result marks it 'unsent', which is what the feed card
  // shows instead of a silent missing globe. A store failure here
  // must never change the publish result or its diagnostics.
  if (event.kind === EVENT_KIND_POST) {
    const store = getStore();
    const idHex = toHex(event.id);
    try {
      if (result.transport === 'relay' || result.transport === 'mesh') {
        await store.markPostOutboxAttempt(idHex, 'ble-sent');
      } else {
        await store.markPostOutboxAttempt(idHex, 'unsent');
      }
    } catch {
      // Outbox bookkeeping is secondary to the publish result.
    }
  }
  const nowMs = Date.now();
  // Diagnostics record exactly the stages the router actually ran: a
  // relay win also runs a best-effort Bluetooth leg to connected peers
  // (v0.1.19), a skipped relay stage is marked skipped (not failed),
  // and a queued result records both stages as unattempted or failed
  // per the router result.
  const attempts: DiagnosticsMessageAttempt[] = [];
  if (result.transport === 'relay') {
    attempts.push({
      transport: 'relay',
      atMs: nowMs,
      outcome: 'ok',
      // P3-1: result.relays is the first-OK list, not every relay that
      // holds the event (the event was sent to every open relay before
      // any OK arrived). The fuller ack set is NOT collected: waiting
      // for it would delay the router past its first-OK resolution and
      // break the mesh fallback timing. The wording says exactly that.
      detail: result.relayDuplicate
        ? 'relay duplicate: relay already held the event; event sent to open relays'
        : `relay OK from ${result.relays.length} relay(s); event sent to open relays`,
    });
    if (bleFilteredByBackoff) {
      // Peers were connected but the balancer held the radio leg out:
      // the BLE set is serving a backoff after failed sends. Skipped,
      // not failed: nothing was attempted, and the outbox drain
      // re-attempts at the backoff expiry.
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: 'skipped',
        detail: 'BLE set backing off after failed sends',
      });
    } else if (blePeersAtPublish.length > 0) {
      // Relay-plus-BLE: the router handed the event to the radio as
      // well. A completed GATT notify is a radio handoff, not peer
      // delivery, so the wording stays honest either way.
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: result.blePeers > 0 ? 'ok' : 'failed',
        detail:
          result.blePeers > 0
            ? `handed to radio for ${result.blePeers} connected peers (radio handoff only, no peer receipt signal)`
            : 'BLE broadcast reached no peers after relay win',
      });
    }
  } else {
    // Gap 111: when the relay stage was skipped for "network not
    // validated", the diagnostics detail carries the last NetInfo
    // state words, so a stuck validation names its state instead of
    // sitting unexplained. Any other relay detail passes through
    // unchanged, and no connectivity behavior changes here.
    let relayDetail =
      result.relayDetail === 'network not validated'
        ? `network not validated (${lastNetInfoSummary ?? 'no NetInfo state yet'})`
        : result.relayDetail;
    // A backed-off relay reads as "no open socket" at the router, but
    // the reason matters: it is a timed-out path coming back, not a
    // dead network. Name the backoff when it is the cause.
    if (relayDetail === 'no open relay socket') {
      const backedOff = health.relays.filter((r) => r.backoffUntilMs > health.nowMs).length;
      if (backedOff > 0) relayDetail = `no open relay socket (${backedOff} backed off)`;
    }
    attempts.push({
      transport: 'relay',
      atMs: nowMs,
      outcome: result.relayTried ? 'failed' : 'skipped',
      detail: relayDetail,
    });
    if (result.transport === 'mesh') {
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: 'ok',
        // Rank 7, honest BLE wording: a completed GATT notify is a
        // radio handoff, not peer delivery. A notify resolves even
        // with no peer central subscribed, and there is no BLE ack
        // for posts, so no BLE status may claim delivery. The post
        // BLE ack frame is a separate follow-up and is not in this
        // batch.
        detail: `handed to radio for ${result.blePeers} connected peers (radio handoff only, no peer receipt signal)`,
      });
    } else if (bleFilteredByBackoff) {
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: 'skipped',
        detail: 'BLE set backing off after failed sends',
      });
    } else if (blePeersAtPublish.length > 0) {
      // Peers were connected but the router reports queued, so every
      // BLE send failed: record failed, not skipped and not ok.
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: 'failed',
        detail: 'BLE send failed for all connected peers',
      });
    } else {
      attempts.push({
        transport: 'ble',
        atMs: nowMs,
        outcome: 'skipped',
        detail: 'no connected BLE peers',
      });
    }
  }
  recordMessage({
    id: toHex(event.id),
    sequence: postSeqOf(event),
    sizeBytes: encodeEvent(event).length,
    direction: 'outbound',
    kind: messageKindForEventKind(event.kind),
    attempts,
    finalStatus:
      result.transport === 'relay'
        ? 'relayed'
        : result.transport === 'mesh'
          ? 'handed to radio over BLE'
          : 'not delivered to any transport',
  });
  return result;
}

