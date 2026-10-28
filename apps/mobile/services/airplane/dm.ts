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
  dmKeypairFromDeviceSecret,
  dmToHex,
} from '@airplane/transport';
import { SqliteDmStore } from './dmSqlite';
import { getDeviceKeypair, onIdentityChange } from './identity';
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
      relay: new WsDmRelay(),
      ownKeys: () => dmKeypairFromDeviceSecret(kp.secretKey),
      ownMeshHex: () => ownHex,
    });
    svc.start();
    service = svc;
    return svc;
  })();
  return servicePromise;
}

/** Anonymous label for a DM peer, same shape as feed author labels. */
export function dmPeerLabel(peerHex: string): string {
  return 'anon·' + peerHex.slice(0, 4);
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

/** Test seam: drop the singleton so tests get a fresh service. */
export function __resetDmServiceForTests(): void {
  resetDmService();
}
