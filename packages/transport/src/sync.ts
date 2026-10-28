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
//
// RETRY POLICY: this engine itself has no backoff. Its caller ticks it on
// a fixed 60 s timer with no backoff (see services/airplane/transport.ts
// SYNC_INTERVAL_MS); a failed pass simply retries on the next tick.

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
/** Max unconfirmed ids handled in one pass, so a pass stays bounded. */
export const SYNC_MAX_PER_PASS = 50;

/** Store reads are batched in pages of this size, not one by one. */
export const SYNC_PAGE_SIZE = 20;

export interface WorldSyncOpts {
  /** Deadline per publish ACK wait, ms. Default 5000 (router deadline). */
  ackDeadlineMs?: number;
}

export class WorldSync {
  /** In-flight pass, shared by concurrent callers so ticks cannot overlap. */
  private inFlight: Promise<SyncReport> | null = null;
  private readonly ackDeadlineMs: number;

  constructor(
    private readonly nostr: NostrTransport,
    private readonly store: WorldConfirmStore,
    opts: WorldSyncOpts = {},
  ) {
    this.ackDeadlineMs = opts.ackDeadlineMs ?? 5000;
  }

  /**
   * One sync pass. Concurrent callers share the in-flight pass instead
   * of starting a second one (the 60s timer and the connectivity-online
   * transition both call this, and a slow pass used to overlap the next).
   */
  sync(): Promise<SyncReport> {
    if (this.inFlight) return this.inFlight;
    const run = this.doSync().finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async doSync(): Promise<SyncReport> {
    const report: SyncReport = { pushed: [], confirmed: [], skipped: [] };
    if (!this.nostr.online) return report;

    // Bounded pass: only the first SYNC_MAX_PER_PASS ids are handled;
    // the rest wait for the next tick instead of growing this pass.
    const unconfirmed = (await this.store.getUnconfirmed()).slice(0, SYNC_MAX_PER_PASS);

    // 1. Push each unconfirmed event to relays. Store reads for a page
    //    run concurrently (batched), and pushes for a page run
    //    concurrently too; pages stay sequential so one pass cannot
    //    flood the store or the relays with the whole backlog at once.
    const pushedIds: Hex64[] = [];
    for (let i = 0; i < unconfirmed.length; i += SYNC_PAGE_SIZE) {
      const page = unconfirmed.slice(i, i + SYNC_PAGE_SIZE);
      const events = await Promise.all(
        page.map(async (idHex) => {
          if (await this.store.isWorldConfirmed(idHex)) {
            report.skipped.push(idHex);
            return null;
          }
          const event = await this.store.getEvent(idHex);
          if (!event) {
            report.skipped.push(idHex);
            return null;
          }
          return { idHex, event };
        }),
      );
      const pushed = await Promise.all(
        events.map(async (row) => {
          if (!row) return null;
          // Acceptance, not send success: only a relay OK counts as
          // pushed. A relay that silently drops the event is re-pushed
          // on a later pass, exactly like an unconfirmed post.
          const ack = await this.nostr.publishWithAck(row.event, this.ackDeadlineMs);
          return ack.ok.length > 0 ? row.idHex : null;
        }),
      );
      for (const idHex of pushed) if (idHex) pushedIds.push(idHex);
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
      // Deliver first, confirm second: a confirmation-write failure must
      // never block storage of the event itself, and it has its own
      // catch so it cannot escape as an unhandled rejection either.
      onEvent(event, source);
      if (source === 'nostr') {
        const idHex = toHex(event.id);
        try {
          await this.store.markWorldConfirmed(idHex);
        } catch {
          // Confirmation is a secondary write; the event is already
          // delivered, and WorldSync re-confirms on a later pass.
          // Confirmation is a hint, delivery is the requirement: a failed
          // confirmation write must never drop the inbound event. The
          // event still flows to the handler below, and the next sync
          // pass re-checks confirmation for it.
        }
      }
    };
  }

  /** Mark one event confirmed (e.g. when the `e` tag matches a query hit). */
  async markConfirmed(idHex: Hex64): Promise<void> {
    await this.store.markWorldConfirmed(idHex);
    // Note: confirmation is sticky - no un-confirm path by design.
  }
}
