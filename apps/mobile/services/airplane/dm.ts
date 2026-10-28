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
// PERSISTENCE NOTE (P1 follow-up): the store below is MemoryDmStore —
// conversations survive only for the app session. A SQLite DmStore on
// SEPARATE dm_* tables (same DmStorePort) is the follow-up; the service,
// routing, outbox and UI do not change when it lands.

import {
  DmService,
  MemoryDmStore,
  WsDmRelay,
  dmKeypairFromDeviceSecret,
  dmToHex,
} from '@airplane/transport';
import { getDeviceKeypair, onIdentityChange } from './identity';

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
      store: new MemoryDmStore(),
      relay: new WsDmRelay(),
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

/** Anonymous label for a DM peer, same shape as feed author labels. */
export function dmPeerLabel(peerHex: string): string {
  return 'anon·' + peerHex.slice(0, 4);
}

/** Send a DM and immediately attempt delivery (outbox retries on failure). */
export async function sendDm(peerHex: string, text: string): Promise<void> {
  const svc = await getDmService();
  await svc.sendMessage(peerHex, text);
  await svc.flushOutbox();
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
