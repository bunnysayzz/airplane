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
import { toHex } from '@airplane/protocol';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';
import { getDeviceKeypair } from './identity';
import { GattBlePort, defaultBleDeps, type BleNativeDeps } from './ble/gatt';
import { ensureBlePermissions } from './ble/permissions';

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
let blePort: { port: TransportPort; close: () => Promise<void> } | null = null;
let bleScanUnsub: (() => void) | null = null;

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
  const store = getStore();
  // Store the event (deduped by HybridTransport already).
  // saveEvent is idempotent.
  await store.saveEvent(event);
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
  const ble = new BleTransport(blePort.port);
  hybrid = new HybridTransport(ble, {
    // Default public relays; TODO: make configurable in settings.
    relays: [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.nostr.band',
    ],
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
    throw new Error('transport failed to start; running offline-only');
  }

  // Bring up the BLE radio: advertise our identity, scan for mesh peers.
  // Any failure here is non-fatal - the mesh simply runs without the radio
  // (Nostr-only), exactly like the old no-op port behaved.
  try {
    const { publicKey } = await getDeviceKeypair();
    const peerIdHex = toHex(publicKey);
    await blePort.port.advertise(peerIdHex);
    bleScanUnsub = await blePort.port.scan(() => {
      // Peer registry for future UI (MeshStatus); discovery itself drives
      // the port's auto-connect. Nothing to do per peer in v1.
    });
  } catch {
    // Radio unavailable (no BLE, permissions denied, native lib missing):
    // tear down whatever half-started and continue Nostr-only.
    try {
      bleScanUnsub?.();
    } catch {
      // ignore
    }
    bleScanUnsub = null;
    await blePort.port.stopAdvertise().catch(() => {});
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

/**
 * Test seam: the live HybridTransport, or null before startTransport().
 * Lets tests drive ingress() through the real app wiring (e.g. verify a
 * relay-observed post gets World-confirmed).
 */
export function __getHybridForTests(): HybridTransport | null {
  return hybrid;
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
    const online = !!state.isConnected && !!state.isInternetReachable;
    if (online) {
      void hybrid?.nostr.start();
      void runSync();
      // Periodic sync while online.
      startSyncTimer();
    } else {
      void hybrid?.nostr.stop();
      stopSyncTimer();
    }
  });

  // Initial state check (addEventListener also fires on subscribe, but the
  // explicit fetch covers mocks/listener quirks).
  void netInfo.fetch().then((initial) => {
    if (initial.isConnected && initial.isInternetReachable) {
      void runSync();
      startSyncTimer();
    }
  });
}

/** Stop the transport. Call on app teardown (rarely needed on mobile). */
export async function stopTransport(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  netUnsub?.();
  netUnsub = null;
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
}

/** Publish a local event through all available transports. */
export async function publishViaTransport(
  event: SignedEvent,
): Promise<{ blePeers: number; relays: string[] }> {
  if (!hybrid) await startTransport();
  return hybrid!.publish(event);
}
