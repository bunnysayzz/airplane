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
import { registerDmBlePort, flushDmOutboxIfStarted, refreshDmSubscriptionIfStarted } from './dm';
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

async function handleIncoming(event: SignedEvent, source: string): Promise<void> {
  // STAR MVP: kind-4 events never reach the events table - its schema
  // CHECKs kind IN (1,2,3). They go to the in-memory star counter instead
  // (same BLE + Nostr ingress path, same event-id dedup upstream).
  if (event.kind === EVENT_KIND_STAR) {
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
    if (!saved.ok && (source === 'nostr' || source === 'ble')) {
      // The count already applied; rehydration reconciles later. The
      // failure is logged with its reason instead of swallowed, so a
      // reshare persistence problem is visible in the next log. Local
      // publish echoes are not logged as inbound failures.
      recordMessage({
        id: toHex(event.id),
        sequence: null,
        sizeBytes: encodeEvent(event).length,
        direction: 'inbound',
        attempts: [
          {
            transport: source === 'nostr' ? 'relay' : 'ble',
            atMs: Date.now(),
            outcome: 'failed',
            detail: `store save failed reshare ${saved.code}`,
          },
        ],
        finalStatus: 'receive failed',
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
      sequence: null,
      sizeBytes: encodeEvent(event).length,
      direction: 'inbound',
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
          sequence: null,
          sizeBytes: encodeEvent(event).length,
          direction: 'inbound',
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
        sequence: null,
        sizeBytes: encodeEvent(event).length,
        direction: 'inbound',
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
    } else if (state === 'on' && radioWasOn && bleRadioState !== 'on') {
      void revalidateBleRadio();
    }
  });
}

/**
 * Re-validate the radio on foreground (AppState active) and on
 * adapter-powered-on. Guarded: runs only when the radio was previously on
 * (or is currently on, for the revocation check); a radio that never came
 * up stays with the priming UI. When the radio is on, a missing grant or
 * a powered-off adapter reclassifies it; when it is not on, a live adapter
 * plus grants re-runs bring-up. Never throws.
 */
export async function revalidateBleRadio(): Promise<void> {
  if (!hybrid || !blePort) return;
  if (bleRadioState === 'starting') return;
  // Guard: a radio that was never on and is not permission-blocked stays
  // with the priming UI. Permission-blocked is included because a grant
  // made in Settings while the app runs must be picked up on foreground,
  // not only on next launch.
  if (!radioWasOn && bleRadioState !== 'on' && bleRadioState !== 'permission-blocked') return;
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
  // fires on a 0 to N change it observed while running.
  if (bleRadioState === 'on') void drainPostOutbox().catch(() => {});
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
  sync = new WorldSync(hybrid.nostr, {
    markWorldConfirmed: (id: Hex64) => getStore().markWorldConfirmed(id),
    isWorldConfirmed: (id: Hex64) => getStore().isWorldConfirmed(id),
    getUnconfirmed: () => getStore().getUnconfirmed(),
    getEvent: (id: Hex64) => getStore().getEvent(id),
  } satisfies WorldConfirmStore);

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
 * advertising fails. Concurrent callers join the in-flight bring-up
 * instead of racing it (mesh-scan fix): without this, two bring-ups
 * at startup each ran the native scan and the logs showed double
 * scan started lines.
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
 * Callers still mark the radio 'on' after this resolves: 'on' means
 * the radio is up (advertising); live scan health is in diagnostics
 * (scanning state plus last failure) and in bleScanUp.
 */
async function bringUpBleRadioInner(peerIdHex: string): Promise<void> {
  if (!blePort) throw new Error('ble: port not constructed');
  await blePort.port.advertise(peerIdHex);
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

export function subscribeMeshStatus(cb: () => void): () => void {
  const timer = setInterval(() => {
    const before = meshSnapshot;
    const next = getMeshStatus();
    if (next !== before) cb();
    // BLE peer arrival is a transport return for the DM outbox: a queued
    // DM drains over mesh now, not when its backoff timer would fire.
    // Edge-triggered (0 to N) so a steady peer set does not re-flush
    // every poll and burn outbox attempts. The same edge drains the
    // post outbox over BLE: a post queued with no peers gets its
    // BLE re-send when a peer nears, without waiting for internet.
    if (prevMeshPeers === 0 && next.peersNearby > 0) {
      void flushDmOutboxIfStarted(true).catch(() => {});
      void drainPostOutbox().catch(() => {});
    }
    prevMeshPeers = next.peersNearby;
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
 * starts the periodic sync timer; offline stops the sockets and timer.
 * BLE always runs (mesh works offline - that is the point of the app);
 * only the Nostr/World side follows connectivity.
 *
 * The shared funnel matters: NetInfo reports isInternetReachable: null
 * until its reachability check lands, so the listener can fire offline
 * first and the fetch resolve online after. Before this funnel the fetch
 * path never restarted Nostr - it only ran sync + timer - so after that
 * race the silent WorldSync uplink stayed dead until the next
 * connectivity flap. Transitions only: duplicates are no-ops.
 */
function applyConnectivity(online: boolean): void {
  if (online === lastOnline) return;
  lastOnline = online;
  connectivityKnown = true;
  if (online) {
    addBreadcrumb('transport: connectivity online');
    void hybrid?.nostr.start();
    void runSync();
    // Periodic sync while online.
    startSyncTimer();
    // A transport returning drains the DM queue and replays missed DMs
    // and acks: both are no-ops when the DM service was never started.
    void flushDmOutboxIfStarted(true).catch(() => {});
    void refreshDmSubscriptionIfStarted().catch(() => {});
  } else {
    addBreadcrumb('transport: connectivity offline');
    void hybrid?.nostr.stop();
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
  netUnsub?.();
  netUnsub = null;
  lastOnline = null;
  lastNetInfoSummary = null;
  connectivityKnown = false;
  clearScanRetry();
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
 * Returns the count of rows sent to at least one peer. Never throws.
 */
export async function drainPostOutbox(): Promise<number> {
  if (!hybrid) return 0;
  const peers = blePeerIdsForPublish(blePort?.port);
  if (peers.length === 0) return 0;
  let sentRows = 0;
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
      const sent = await hybrid.sendOverMesh(event, peers).catch(() => 0);
      if (sent > 0) {
        sentRows += 1;
        await store.markPostOutboxAttempt(row.eventId, 'ble-sent').catch(() => {});
      } else {
        await store.markPostOutboxAttempt(row.eventId, 'unsent').catch(() => {});
      }
    }
  } catch {
    // A drain failure must never break the caller (mesh poll, start,
    // or foreground): the rows stay queued for the next trigger.
  }
  if (sentRows > 0) notifyFeedListeners();
  return sentRows;
}

/** Publish a local event through the ordered router (R4). */
export async function publishViaTransport(event: SignedEvent): Promise<RouteResult> {
  if (!hybrid) await startTransport();
  // BLE fan-out targets the currently connected peers. Previously this
  // call passed no peer ids at all, so local posts NEVER went out over
  // BLE - only Nostr - even with phones connected over GATT.
  const blePeersAtPublish = blePeerIdsForPublish(blePort?.port);
  const result = await hybrid!.publish(event, blePeersAtPublish);
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
  // not outbox posts). A relay win already deleted the row via
  // markWorldConfirmed, so the remove here is idempotent cleanup;
  // a mesh send keeps the row as 'ble-sent' (still awaiting World);
  // a queued result marks it 'unsent', which is what the feed card
  // shows instead of a silent missing globe. A store failure here
  // must never change the publish result or its diagnostics.
  if (event.kind === EVENT_KIND_POST) {
    const store = getStore();
    const idHex = toHex(event.id);
    try {
      if (result.transport === 'relay') {
        await store.removePostOutbox(idHex);
      } else if (result.transport === 'mesh') {
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
      detail: `relay OK from ${result.relays.length} relay(s); event sent to open relays`,
    });
    if (blePeersAtPublish.length > 0) {
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
    const relayDetail =
      result.relayDetail === 'network not validated'
        ? `network not validated (${lastNetInfoSummary ?? 'no NetInfo state yet'})`
        : result.relayDetail;
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
    sequence: null,
    sizeBytes: encodeEvent(event).length,
    direction: 'outbound',
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

