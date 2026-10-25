// SPDX-License-Identifier: Apache-2.0
// DM app wiring: one DmService singleton for the UI.
// Keys come from the existing device identity (identity.ts): the DM keypair
// is derived from the device Ed25519 secret, no new key material, no T8 yet
// (see dm-plan.md §8 + dm.ts header for the T8 caveat).
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
import { getDeviceKeypair } from './identity';

let service: DmService | null = null;
let servicePromise: Promise<DmService> | null = null;

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

/** Test seam: drop the singleton so tests get a fresh service. */
export function __resetDmServiceForTests(): void {
  if (service) service.stop();
  service = null;
  servicePromise = null;
}
