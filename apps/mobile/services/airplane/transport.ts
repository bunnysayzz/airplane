// SPDX-License-Identifier: Apache-2.0
// Transport manager: owns the HybridTransport lifecycle.
//
// - BLE transport runs always (currently a no-op stub until the P0 radio
//   spike lands real GATT; the flood engine interface is frozen).
// - Nostr transport starts/stops with connectivity (NetInfo, no Google
//   Play Services dependency).
// - Incoming posts from any source are stored and fed to the UI.
// - WorldSync runs when online to push unconfirmed posts and check relays.

import NetInfo from '@react-native-community/netinfo';
import {
  HybridTransport,
  BleTransport,
  WorldSync,
  type WorldConfirmStore,
} from '@airplane/transport';
import type { SignedEvent, TransportPort, Hex64 } from '@airplane/protocol';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';

/**
 * No-op BLE port until real GATT lands (P0). Satisfies TransportPort so
 * HybridTransport can start; all methods are inert.
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

const SYNC_INTERVAL_MS = 60_000; // re-check World status every minute when online

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
 */
export async function startTransport(): Promise<void> {
  if (hybrid) return;

  const ble = new BleTransport(new NoopBlePort());
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

  hybrid.onPost((event) => {
    void handleIncoming(event);
  });

  await hybrid.start();

  // React to connectivity changes.
  netUnsub = NetInfo.addEventListener((state) => {
    const online = !!state.isConnected && !!state.isInternetReachable;
    if (online) {
      void hybrid?.nostr.start();
      void runSync();
      // Periodic sync while online.
      if (!syncTimer) {
        syncTimer = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
      }
    } else {
      void hybrid?.nostr.stop();
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
    }
  });

  // Initial state check.
  const initial = await NetInfo.fetch();
  if (initial.isConnected && initial.isInternetReachable) {
    void runSync();
    syncTimer = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
  }
}

/** Stop the transport. Call on app teardown (rarely needed on mobile). */
export async function stopTransport(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  netUnsub?.();
  netUnsub = null;
  await hybrid?.stop();
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
