// SPDX-License-Identifier: Apache-2.0
// DM app wiring: one DmService singleton for the UI.
// Keys come from the existing device identity (identity.ts): the DM keypair
// is derived from the device Ed25519 secret, no new key material.
// T8 HONEST EXCEPTION: this derivation CANNOT go behind the
// KeyStorePort.sign() seam - deriving an X25519 keypair from the Ed25519
// secret needs the secret itself, not a signature over a message. So dm.ts
// remains, with identity.ts's custody owner, the only app module that
// receives the secret - and only to derive (never to store or log) the DM
// keys. Consequence of T8 rotation: the DM address changes with the mesh
// identity (same derivation, new secret), so old DM peers cannot reach the
// new identity; the rotation screen says so, and rotation resets this
// singleton so the next DM derives from the new key.
// PERSISTENCE: the store below is SqliteDmStore (SEPARATE dm_* tables in
// the app database, see dmSqlite.ts), so conversations, the outbox, and
// delivery state survive app restarts. The service, routing, outbox, and
// UI all talk DmStorePort, so the store change does not touch them.
// TRANSPORT: relay first (pooled WsDmRelay with ack kind), BLE mesh
// alongside it (DmBleTransport over the transport manager's BLE port,
// registered after the radio starts; a service created before that picks
// the port up from the pending registration). Delivery states stay honest:
// relay OK lands in Relayed and BLE notify in MeshSent, and only a
// verified peer ack lands in Delivered.

import type { TransportPort } from '@airplane/protocol';
import {
  DmBleTransport,
  DmService,
  WsDmRelay,
  dmFromHex,
  dmKeypairFromDeviceSecret,
  dmToHex,
} from '@airplane/transport';
import { getDeviceKeypair, onIdentityChange } from './identity';
import { loadRelayUrls } from '../../src/lib/relays';
import { SqliteDmStore } from './dmSqlite';
import { createSqliteDatabasePort } from './sqlite';
import { formatPeerName } from './displayNames';

let service: DmService | null = null;
let servicePromise: Promise<DmService> | null = null;
/**
 * BLE port owned by the transport manager, registered here when the radio
 * starts (and re-registered when the port is recreated). Kept apart from
 * the service so the transport manager never imports the DM singleton
 * lifecycle: it registers a port, and the next service creation (or the
 * live service, via attach below) picks it up.
 */
let pendingBlePort: TransportPort | null = null;

/** Drop the singleton (T8 rotation: the next DM derives from the new key). */
export function resetDmService(): void {
  if (service) service.stop();
  service = null;
  servicePromise = null;
}

// T8 rotation changes the DM address (derived from the mesh secret), so a
// burn must not leave a singleton keyed to the old secret alive.
onIdentityChange(resetDmService);

export async function getDmService(): Promise<DmService> {
  if (service) return service;
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const kp = await getDeviceKeypair();
    const ownHex = dmToHex(kp.publicKey);
    const svc = new DmService({
      store: new SqliteDmStore(createSqliteDatabasePort()),
      // Same configured list as the post path: DMs must not silently
      // keep using package defaults the user removed in Settings.
      relay: new WsDmRelay({ relays: await loadRelayUrls(), allowPrivateRelays: true }),
      mesh: pendingBlePort ? new DmBleTransport(pendingBlePort) : undefined,
      ownKeys: () => dmKeypairFromDeviceSecret(kp.secretKey),
      ownMeshHex: () => ownHex,
    });
    svc.start();
    service = svc;
    return svc;
  })();
  // A rejected creation must not poison the singleton for the session:
  // clear the cached promise (and service) so the next caller retries,
  // mirroring identity.ts getDeviceKeypair. The rejection still reaches
  // this caller; the catch only resets the cache.
  servicePromise.catch(() => {
    servicePromise = null;
    service = null;
  });
  return servicePromise;
}

/**
 * Display label for a DM peer: the signed display name when this device
 * knows one, else the memorable name WITHOUT the hex suffix. A suffix
 * appears only when the registry knows another peer with the same base
 * name (see displayNames.ts). The full label and full key stay visible
 * on the Identity screen and in the thread details view. Kept as the
 * label function (not a new name) so every DM surface changes together.
 */
export function dmPeerLabel(peerHex: string): string {
  const bytes = dmFromHex(peerHex);
  if (bytes && bytes.length === 32) return formatPeerName(peerHex.toLowerCase());
  return 'anon·' + peerHex.slice(0, 4);
}

/**
 * User-facing copy for DM failures. Known errors map to friendly lines;
 * everything else maps to a generic line. Raw error text is never shown:
 * it can carry file paths, keys, or stack details the user must not see.
 */
export function dmUserErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message;
    if (m.includes('peer is blocked')) return 'This conversation is blocked. Unblock it to send again.';
    if (m.includes('longer than')) return 'That message is too long to send.';
    if (m.includes('empty DM')) return 'Write a message before sending.';
    if (m.includes('cannot DM yourself')) return 'You cannot message yourself.';
    if (
      m.includes('must be 64 lowercase hex') ||
      m.includes('bad sender pubkey') ||
      m.includes('bad recipient pubkey')
    ) {
      return 'That conversation key is not valid.';
    }
  }
  return 'Something went wrong. Try again.';
}

/**
 * Register the BLE port for DM mesh transport. Called by the transport
 * manager when the radio starts (and when the port is recreated). A live
 * service re-attaches at once (the old port subscription is dropped, so
 * a recreated radio never leaves a stale port listening); a service
 * created later picks the port up from the pending registration.
 */
export function registerDmBlePort(port: TransportPort | null): void {
  pendingBlePort = port;
  if (service) service.attachMesh(port ? new DmBleTransport(port) : null);
}

/**
 * Send a DM. Optimistic UI: the row is stored (status Sending) and
 * returned at once, so the thread shows it immediately; the outbox flush
 * then runs in the background and the service emit refreshes the thread
 * when the status moves. Previously this awaited the flush, so the
 * message appeared only after the relay round-trip (up to 40 s on the
 * old sequential relay path) and the Send button stayed disabled that
 * whole time: the "stuck on Sending" feel from the field test.
 */
export async function sendDm(peerHex: string, text: string): Promise<void> {
  const svc = await getDmService();
  await svc.sendMessage(peerHex, text);
  // Background flush: a store failure here must not unreject the send
  // (the row is already stored as Sending and retries on the next flush).
  void svc.flushOutbox().catch(() => {
    /* status stays Sending; next flush retries */
  });
}

/**
 * Foreground flush for the outbox scheduler (P1-09): drains Sending and
 * Queued rows when the app returns to foreground, since timers do not
 * reliably fire while backgrounded. Forced, so rows queued with a future
 * backoff time still drain now that the user is back. Deliberately a
 * no-op when the service was never started, so a foreground event never
 * eagerly creates DM subscriptions for a user who never opened Messages.
 */
export async function flushDmOutboxIfStarted(force = false): Promise<void> {
  if (service) await service.flushOutbox(force);
}

/**
 * Foreground subscription refresh: re-issues the relay subscription with
 * a backfill from the stored watermark, so messages and acks that arrived
 * while the app was backgrounded (or while a socket sat half-open) replay
 * instead of staying silently missed. Same no-op guard as the flush.
 */
export async function refreshDmSubscriptionIfStarted(): Promise<void> {
  if (service) await service.resubscribe();
}

/** Test seam: drop the singleton so tests get a fresh service. */
export function __resetDmServiceForTests(): void {
  resetDmService();
}
