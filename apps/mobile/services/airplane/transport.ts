// SPDX-License-Identifier: Apache-2.0
// Transport manager: owns the HybridTransport lifecycle.
//
// - BLE transport runs always (real GATT port on device; fails closed to
//   inert when the radio, permissions, or native modules are unavailable).
// - Nostr transport starts/stops with connectivity (NetInfo, no Google
//   Play Services dependency).
// - Incoming posts from any source are stored and fed to the UI.
// - WorldSync runs when online to push unconfirmed posts and check relays.

import type { NetInfoState } from '@react-native-community/netinfo';
import {
  HybridTransport,
  BleTransport,
  WorldSync,
  type WorldConfirmStore,
} from '@airplane/transport';
import type { SignedEvent, TransportPort, Hex64 } from '@airplane/protocol';
import { toHex, verifyEvent } from '@airplane/protocol';
import { getStore } from './store';
import { EVENT_KIND_POST, EVENT_KIND_STAR } from '@airplane/protocol';
import { applyIncomingStar, markStarPostKnown } from './stars';
import { notifyFeedListeners } from './feed';
import { getDevicePublicKey, crypto } from './identity';
import { loadRelayUrls } from '../../src/lib/relays';
import { addBreadcrumb } from '../../src/sentry';
import { GattBlePort, defaultBleDeps, type BleNativeDeps } from './ble/gatt';
import { ensureBlePermissions, checkBlePermissions, requestBlePermissions } from './ble/permissions';

/**
 * NetInfo is a native module. If it fails to load (not linked, Expo Go,
 * etc.), the app must still launch — transport just runs offline-only.
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
function makeBlePort(): { port: TransportPort; close: () => Promise<void> } {
  let deps: BleNativeDeps;
  try {
    deps = defaultBleDeps(ensureBlePermissions);
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
let blePort: { port: TransportPort; close: () => Promise<void> } | null = null;
let bleScanUnsub: (() => void) | null = null;
/**
 * BLE radio state. 'permission-blocked' means the OS grants are missing and
 * the priming UI (BlePrime) owns the request; 'unavailable' means the radio
 * failed for another reason (no BLE hardware, native lib missing).
 */
export type BleRadioState = 'starting' | 'on' | 'permission-blocked' | 'unavailable';
let bleRadioState: BleRadioState = 'starting';

const SYNC_INTERVAL_MS = 60_000; // re-check World status every minute when online

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

async function handleIncoming(event: SignedEvent): Promise<void> {
  // STAR MVP: kind-4 events never reach the events table — its schema
  // CHECKs kind IN (1,2,3). They go to the in-memory star counter instead
  // (same BLE + Nostr ingress path, same event-id dedup upstream).
  if (event.kind === EVENT_KIND_STAR) {
    if (applyIncomingStar(event)) notifyFeedListeners();
    return;
  }
  const store = getStore();
  // Store the event (deduped by HybridTransport already).
  // saveEvent is idempotent.
  await store.saveEvent(event);
  // A post arriving may release stars held pending for it.
  if (event.kind === EVENT_KIND_POST) markStarPostKnown(toHex(event.id));
  notifyFeedListeners();
}

async function runSync(): Promise<void> {
  if (!sync || !hybrid?.nostr.online) return;
  try {
    const report = await sync.sync();
    if (report.confirmed.length > 0) {
      notifyFeedListeners(); // globe icons may have appeared
    }
  } catch {
    // Sync failures are non-fatal; retry on next interval.
  }
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
  // BLE ingress verifies signatures, matching the Nostr path (T11 §23.6):
  // an unsigned/tampered event from a mesh peer never reaches the store.
  const ble = new BleTransport(blePort.port, {
    verify: (event) => verifyEvent(crypto, event),
  });
  // Relay list is user-configurable in Settings > Relays and persisted in
  // AsyncStorage (src/lib/relays.ts). loadRelayUrls() already falls back to
  // the default public relays when nothing is stored — and never throws —
  // so a storage failure here just means the defaults, never a dead uplink.
  hybrid = new HybridTransport(ble, {
    relays: await loadRelayUrls(),
  });
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
    sync.confirmListener((event) => {
      void handleIncoming(event);
    }),
  );

  try {
    await hybrid.start();
  } catch {
    // Never leave a half-started transport behind: reset module state so a
    // later startTransport() can retry cleanly. The app runs offline-only.
    await blePort?.close();
    blePort = null;
    hybrid = null;
    sync = null;
    lastOnline = null;
    throw new Error('transport failed to start; running offline-only');
  }

  // Bring up the BLE radio only when the OS grants are already in place.
  // The OS permission dialog NEVER fires here: permission priming (the app's
  // own rationale UI first, OS request only on the user's action) is owned
  // by the BlePrime UI. A missing grant just leaves the radio down — the
  // mesh runs Nostr-only, exactly like the old no-op port behaved.
  if (await checkBlePermissions().catch(() => false)) {
    try {
      const publicKey = await getDevicePublicKey();
      await bringUpBleRadio(toHex(publicKey));
      bleRadioState = 'on';
    } catch {
      // Radio unavailable (no BLE, native lib missing): tear down whatever
      // half-started and continue Nostr-only.
      await tearDownBleRadio();
      bleRadioState = 'unavailable';
    }
  } else {
    bleRadioState = 'permission-blocked';
  }

  try {
    wireConnectivity();
  } catch {
    // NetInfo listener registration blew up after a successful load:
    // fall back to offline-only (BLE stub), nostr stays as started.
    netUnsub?.();
    netUnsub = null;
  }
}

/** Advertise our identity and scan for mesh peers. Throws on radio failure. */
async function bringUpBleRadio(peerIdHex: string): Promise<void> {
  if (!blePort) throw new Error('ble: port not constructed');
  await blePort.port.advertise(peerIdHex);
  bleScanUnsub = await blePort.port.scan(() => {
    // Peer registry for future UI (MeshStatus); discovery itself drives
    // the port's auto-connect. Nothing to do per peer in v1.
  });
}

/** Tear down whatever half of the radio bring-up succeeded. Never throws. */
async function tearDownBleRadio(): Promise<void> {
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
  /** Established BLE connections (linked neighbours — not merely heard ads). */
  peersNearby: number;
  /** 'mesh' = BLE radio only, 'online' = internet up (World visible), 'offline' = neither. */
  relayState: 'mesh' | 'online' | 'offline';
}

/**
 * Pure relay-state mapping (unit-tested truth table). 'starting' maps to
 * 'mesh' so the pill keeps its boot appearance until a real state is known;
 * a permission-blocked/unavailable radio with Nostr online shows 'online'
 * (truthful: syncing over the internet, NOT the mesh) instead of the old
 * hardcoded 'mesh only' lie.
 */
export function resolveRelayState(nostrOnline: boolean, bleState: BleRadioState): MeshStatusSnapshot['relayState'] {
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
    relayState: resolveRelayState(!!hybrid?.nostr.online, bleRadioState),
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
export function subscribeMeshStatus(cb: () => void): () => void {
  const timer = setInterval(() => {
    const before = meshSnapshot;
    if (getMeshStatus() !== before) cb();
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
    return true;
  } catch {
    bleRadioState = 'unavailable';
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

/**
 * Apply one connectivity state to the transport. Single funnel for both
 * the NetInfo listener and the initial fetch, so both paths behave the
 * same: online (re)starts the relay sockets, runs a WorldSync pass, and
 * starts the periodic sync timer; offline stops the sockets and timer.
 * BLE always runs (mesh works offline — that is the point of the app);
 * only the Nostr/World side follows connectivity.
 *
 * The shared funnel matters: NetInfo reports isInternetReachable: null
 * until its reachability check lands, so the listener can fire offline
 * first and the fetch resolve online after. Before this funnel the fetch
 * path never restarted Nostr — it only ran sync + timer — so after that
 * race the silent WorldSync uplink stayed dead until the next
 * connectivity flap. Transitions only: duplicates are no-ops.
 */
function applyConnectivity(online: boolean): void {
  if (online === lastOnline) return;
  lastOnline = online;
  if (online) {
    addBreadcrumb('transport: connectivity online');
    void hybrid?.nostr.start();
    void runSync();
    // Periodic sync while online.
    startSyncTimer();
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
    // No connectivity module — run offline-only (BLE stub). Nostr stays
    // stopped; the feed works fine without it.
    return;
  }

  // React to connectivity changes.
  netUnsub = netInfo.addEventListener((state) => {
    applyConnectivity(!!state.isConnected && !!state.isInternetReachable);
  });

  // Initial state check (addEventListener also fires on subscribe, but the
  // explicit fetch covers mocks/listener quirks). A fetch rejection must
  // not surface as an unhandled rejection: the listener already covers
  // live transitions.
  void netInfo
    .fetch()
    .then((initial) => {
      applyConnectivity(!!initial.isConnected && !!initial.isInternetReachable);
    })
    .catch(() => {});
}

/** Stop the transport. Call on app teardown (rarely needed on mobile). */
export async function stopTransport(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  netUnsub?.();
  netUnsub = null;
  lastOnline = null;
  try {
    bleScanUnsub?.();
  } catch {
    // ignore
  }
  bleScanUnsub = null;
  await hybrid?.stop();
  await blePort?.close();
  blePort = null;
  hybrid = null;
  sync = null;
  bleRadioState = 'unavailable';
}

/** Publish a local event through all available transports. */
export async function publishViaTransport(
  event: SignedEvent,
): Promise<{ blePeers: number; relays: string[] }> {
  if (!hybrid) await startTransport();
  // BLE fan-out targets the currently connected peers. Previously this
  // call passed no peer ids at all, so local posts NEVER went out over
  // BLE — only Nostr — even with phones connected over GATT.
  return hybrid!.publish(event, blePeerIdsForPublish(blePort?.port));
}
