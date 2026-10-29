// SPDX-License-Identifier: Apache-2.0
// DM app wiring: one DmService singleton for the UI.
// Keys come from the existing device identity (identity.ts): the DM keypair
// is derived from the device Ed25519 secret, no new key material.
// T8 HONEST EXCEPTION: this derivation CANNOT go behind the
// KeyStorePort.sign() seam — deriving an X25519 keypair from the Ed25519
// secret needs the secret itself, not a signature over a message. So dm.ts
// remains, with identity.ts's custody owner, the only app module that
// receives the secret — and only to derive (never to store or log) the DM
// keys. Consequence of T8 rotation: the DM address changes with the mesh
// identity (same derivation, new secret), so old DM peers cannot reach the
// new identity; the rotation screen says so, and rotation resets this
// singleton so the next DM derives from the new key.
// PERSISTENCE (R5): the store below is SqliteDmStore — conversations and
// messages live in the app's SQLite database on SEPARATE dm_* tables (see
// dmSqlite.ts), so they survive app restarts. The service, routing, outbox
// and UI do not change when the store changes: they all talk DmStorePort.

import {
  DmService,
  WsDmRelay,
  dmFromHex,
  dmKeypairFromDeviceSecret,
  dmToHex,
} from '@airplane/transport';
import { SqliteDmStore } from './dmSqlite';
import { getDeviceKeypair, onIdentityChange } from './identity';
import { loadRelayUrls } from '../../src/lib/relays';
import { authorLabelFor } from './names';
import { createSqliteDatabasePort } from './sqlite';

let service: DmService | null = null;
let servicePromise: Promise<DmService> | null = null;

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

/** Anonymous label for a DM peer, same as feed author labels. */
export function dmPeerLabel(peerHex: string): string {
  const bytes = dmFromHex(peerHex);
  if (bytes && bytes.length === 32) return authorLabelFor(bytes);
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
 * Send a DM. R5 optimistic UI: the row is stored (status Sending) and
 * returned at once, so the thread shows it immediately; the outbox flush
 * then runs in the background and the service's emit refreshes the thread
 * when the status moves to Sent/Failed. Previously this awaited the flush,
 * so the message appeared only after the relay round-trip (up to 10 s on
 * the old sequential relay path) — the "slow DM" feel in plan section 7.6.
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
 * Foreground flush for the outbox scheduler (P1-09): drains Sending rows
 * when the app returns to foreground, since timers do not reliably fire
 * while backgrounded. Deliberately a no-op when the service was never
 * started, so a foreground event never eagerly creates DM subscriptions
 * for a user who never opened Messages.
 */
export async function flushDmOutboxIfStarted(): Promise<void> {
  if (service) await service.flushOutbox();
}

/** Test seam: drop the singleton so tests get a fresh service. */
export function __resetDmServiceForTests(): void {
  resetDmService();
}
