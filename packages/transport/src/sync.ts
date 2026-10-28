// SPDX-License-Identifier: Apache-2.0
// World sync engine: opportunistic relay confirmation.
//
// When online, this engine:
//   1. Pushes locally-known but unconfirmed posts to Nostr relays
//      (silent background relay - no user approval, per product decision).
//   2. Queries relays for unconfirmed event IDs (Nostr REQ with `ids`/`#e`
//      filter); on match, marks the event confirmed in storage.
//
// Confirmation is client-side only (never in the signed payload). A post is
// "on World" once ANY copy is observed on a relay - it may have been relayed
// by another phone, not necessarily this one.

import type { Hex64, SignedEvent } from '@airplane/protocol';
import { toHex } from '@airplane/protocol';
import type { NostrTransport } from './nostr';

/**
 * Minimal storage surface the sync engine needs. Implemented by
 * StorePort (packages/storage) - kept as a narrow interface so the engine
 * stays testable without the full store.
 */
export interface WorldConfirmStore {
  markWorldConfirmed(eventId: Hex64): Promise<void>;
  isWorldConfirmed(eventId: Hex64): Promise<boolean>;
  getUnconfirmed(): Promise<Hex64[]>;
  getEvent(id: Hex64): Promise<SignedEvent | null>;
}

export interface SyncReport {
  /** Event IDs pushed to at least one relay. */
  pushed: Hex64[];
  /** Event IDs newly confirmed on a relay. */
  confirmed: Hex64[];
  /** Event IDs skipped (already confirmed, or event missing locally). */
  skipped: Hex64[];
}

/**
 * One sync pass. Safe to call repeatedly; idempotent per event ID.
 * Does nothing when the transport has no open relay.
 */
export class WorldSync {
  constructor(
    private readonly nostr: NostrTransport,
    private readonly store: WorldConfirmStore,
  ) {}

  async sync(): Promise<SyncReport> {
    const report: SyncReport = { pushed: [], confirmed: [], skipped: [] };
    if (!this.nostr.online) return report;

    const unconfirmed = await this.store.getUnconfirmed();

    // 1. Push each unconfirmed event to relays.
    const pushedIds: Hex64[] = [];
    for (const idHex of unconfirmed) {
      if (await this.store.isWorldConfirmed(idHex)) {
        report.skipped.push(idHex);
        continue;
      }
      const event = await this.store.getEvent(idHex);
      if (!event) {
        report.skipped.push(idHex);
        continue;
      }
      const relays = await this.nostr.publish(event);
      if (relays.length > 0) pushedIds.push(idHex);
    }
    report.pushed = pushedIds;

    // 2. Query relays for the IDs we just pushed (plus any still
    //    unconfirmed). Matches arrive via onReceive -> confirmListener.
    const stillOpen = unconfirmed.filter((id) => !report.skipped.includes(id));
    if (stillOpen.length > 0) {
      await this.nostr.queryByIds(stillOpen);
    }
    return report;
  }

  /**
   * Wire this into the transport's onReceive (or HybridTransport.onPost):
   * any event observed from a relay is, by definition, on World.
   * Returns an unsubscribe function.
   */
  confirmListener(onEvent: (event: SignedEvent, source: string) => void): (event: SignedEvent, source: string) => void {
    return async (event: SignedEvent, source: string) => {
      if (source === 'nostr') {
        const idHex = toHex(event.id);
        await this.store.markWorldConfirmed(idHex);
      }
      onEvent(event, source);
    };
  }

  /** Mark one event confirmed (e.g. when the `e` tag matches a query hit). */
  async markConfirmed(idHex: Hex64): Promise<void> {
    await this.store.markWorldConfirmed(idHex);
    // Note: confirmation is sticky - no un-confirm path by design.
  }
}
