// SPDX-License-Identifier: Apache-2.0
// Client-side star counting (STAR MVP, report §4 rules 1-6).
//
// There is no server and no canonical count: every count is a per-node view
// over the events this node has actually seen. The rules, in order:
//
// 1. Dedup by signed event id across transports. The same event arriving
//    via BLE and via Nostr counts once. (Transport-level dedup also exists,
//    but this layer must not trust it: one counter serves both legs.)
// 2. ONE counted star per (pubkey, post). A key starring twice is one star.
// 3. Undo is a state transition with deterministic latest-wins: the winner
//    is the event with the greatest (created_at, event-id-hex) — NEVER
//    arrival order, which differs per node and would make counts diverge.
//    Superseded events are RETAINED in per-key history so an old star
//    arriving after its unstar cannot resurrect a cancelled star.
// 4. Verify signature before counting, never count unverified. The caller
//    supplies the verifier (verifyEvent); this class counts nothing it has
//    not been told is verified.
// 5. Reshare-flattening does not apply to stars. A star for a post not yet
//    seen locally is HELD in a pending queue keyed by target id and applied
//    when the post arrives (markPostKnown) — never dropped, so a node that
//    learns the post late still converges to the same count.
// 6. Counts are per-node views with a sync horizon: snapshots carry cheap
//    provenance (distinct events seen, pending events held) alongside the
//    count. A bare integer is never the stored artefact.
//
// Ranking is deliberately untouched: stars are display-only in v1.
// No proof-of-work, relay curation, or web-of-trust gating lives here —
// the free mitigations (per-key counting + signature verification) are
// the MVP; the rest are future work (report §6).

import { toHex } from '../hex';
import { SeenCache } from '../flood/engine';
import { EVENT_KIND_STAR, type Hex64, type SignedEvent, type UnixSec } from '../events/types';
import { STAR_CONTENT, UNSTAR_CONTENT } from '../payloads/stars';

/** Max clock skew tolerated: events dated further in the future are dropped. */
export const STAR_MAX_FUTURE_SKEW_SEC = 300;

/** Outcome of feeding one event to the counter. */
export type StarApplyResult =
  | 'applied'
  | 'superseded'
  | 'pending'
  | 'duplicate'
  | 'unverified'
  | 'invalid';

export interface StarView {
  /** Distinct pubkeys whose latest state for this post is "star". */
  count: number;
  /** Distinct verified kind-4 events applied for this post (incl. superseded). */
  seenEvents: number;
  /** Verified kind-4 events held pending because the post is not yet known. */
  pendingEvents: number;
  /** True when the given pubkey's latest state for this post is "star". */
  starredByMe: boolean;
}

/** Per-node view of star counts, with provenance. Not persisted in v1. */
export class StarCounter {
  /**
   * Event ids already applied or held pending (dedup across transports).
   * LRU-capped like the transport SeenCache: the persistent star table
   * already dedups on save, so eviction cannot resurrect a count.
   */
  private readonly seenIds = new SeenCache();
  /** Post ids known locally (a post row exists, or the caller said so). */
  private readonly knownPosts = new Set<Hex64>();
  /** (pubkeyHex, targetHex) -> latest state + retained history. */
  private readonly states = new Map<
    string,
    { event: SignedEvent; state: 'star' | 'unstar'; history: SignedEvent[] }
  >();
  /**
   * Per-post index into `states`: targetHex -> state keys for that post.
   * view() reads only this post's entries instead of scanning every
   * (pubkey, post) state on every card, so a feed page costs page size
   * lookups, not page size times total history.
   */
  private readonly statesByPost = new Map<Hex64, Set<string>>();
  /** Target id hex -> verified events held until the post arrives. */
  private readonly pending = new Map<Hex64, SignedEvent[]>();
  /** Post id hex -> distinct verified events applied (provenance). */
  private readonly seenPerPost = new Map<Hex64, number>();

  /** Extract the target post id hex from a kind-4 event's ["e", id] tag. */
  static targetOf(event: SignedEvent): Hex64 | null {
    for (const tag of event.tags) {
      if (tag.length >= 2 && tag[0] === 'e' && /^[0-9a-f]{64}$/.test(tag[1])) {
        return tag[1].toLowerCase();
      }
    }
    return null;
  }

  private static stateOf(event: SignedEvent): 'star' | 'unstar' | null {
    if (event.content === STAR_CONTENT) return 'star';
    if (event.content === UNSTAR_CONTENT) return 'unstar';
    return null;
  }

  /** Deterministic order: greater created_at wins; ties break on greater id hex. */
  private static isNewer(a: SignedEvent, b: SignedEvent): boolean {
    if (a.created_at !== b.created_at) return a.created_at > b.created_at;
    return toHex(a.id) > toHex(b.id);
  }

  /** Mark a post as known and apply any pending stars held for it. */
  markPostKnown(postIdHex: Hex64): void {
    const id = postIdHex.toLowerCase();
    this.knownPosts.add(id);
    const held = this.pending.get(id);
    if (!held) return;
    this.pending.delete(id);
    for (const event of held) this.applyVerified(event);
  }

  /** True when the post id is already known locally. */
  isPostKnown(postIdHex: Hex64): boolean {
    return this.knownPosts.has(postIdHex.toLowerCase());
  }

  /**
   * Feed one kind-4 event to the counter. `verify` must be the real
   * signature check (verifyEvent); an event that fails it is never counted
   * and never retained. `nowSec` is injectable for tests.
   */
  apply(
    event: SignedEvent,
    verify: (event: SignedEvent) => boolean,
    nowSec: UnixSec = Math.floor(Date.now() / 1000),
  ): StarApplyResult {
    if (event.kind !== EVENT_KIND_STAR) return 'invalid';
    if (StarCounter.stateOf(event) === null) return 'invalid';
    const target = StarCounter.targetOf(event);
    if (target === null) return 'invalid';
    if (event.created_at > nowSec + STAR_MAX_FUTURE_SKEW_SEC) return 'invalid';
    if (!verify(event)) return 'unverified';
    const idHex = toHex(event.id);
    if (this.seenIds.has(idHex)) return 'duplicate';
    this.seenIds.add(idHex);
    if (!this.knownPosts.has(target)) {
      const held = this.pending.get(target) ?? [];
      held.push(event);
      this.pending.set(target, held);
      return 'pending';
    }
    return this.applyVerified(event);
  }

  /** Apply an already-verified, already-deduped event to latest-wins state. */
  private applyVerified(event: SignedEvent): StarApplyResult {
    const target = StarCounter.targetOf(event);
    const state = StarCounter.stateOf(event);
    if (target === null || state === null) return 'invalid';
    const key = `${toHex(event.pubkey)}:${target}`;
    this.seenPerPost.set(target, (this.seenPerPost.get(target) ?? 0) + 1);
    const prev = this.states.get(key);
    if (prev) {
      // Retain the superseded event: it is the evidence that lets a still
      // older duplicate (or a replayed star) be recognised as superseded
      // rather than as the current state.
      prev.history.push(event);
      if (!StarCounter.isNewer(event, prev.event)) return 'superseded';
      prev.event = event;
      prev.state = state;
      return 'applied';
    }
    this.states.set(key, { event, state, history: [event] });
    let keys = this.statesByPost.get(target);
    if (!keys) {
      keys = new Set();
      this.statesByPost.set(target, keys);
    }
    keys.add(key);
    return 'applied';
  }

  /** Current view for one post, with provenance. `ownPubkeyHex` may be null. */
  view(postIdHex: Hex64, ownPubkeyHex: Hex64 | null = null): StarView {
    const target = postIdHex.toLowerCase();
    let count = 0;
    let starredByMe = false;
    for (const key of this.statesByPost.get(target) ?? []) {
      const entry = this.states.get(key);
      if (!entry || entry.state !== 'star') continue;
      count += 1;
      if (ownPubkeyHex !== null && key.startsWith(`${ownPubkeyHex.toLowerCase()}:`)) {
        starredByMe = true;
      }
    }
    return {
      count,
      seenEvents: this.seenPerPost.get(target) ?? 0,
      pendingEvents: this.pending.get(target)?.length ?? 0,
      starredByMe,
    };
  }

  /** Latest kind-4 event from this pubkey for this post, or null. */
  latestFor(postIdHex: Hex64, pubkeyHex: Hex64): SignedEvent | null {
    const entry = this.states.get(`${pubkeyHex.toLowerCase()}:${postIdHex.toLowerCase()}`);
    return entry ? entry.event : null;
  }

  /** True when the pubkey's latest state for the post is "star". */
  isStarred(postIdHex: Hex64, pubkeyHex: Hex64): boolean {
    const entry = this.states.get(`${pubkeyHex.toLowerCase()}:${postIdHex.toLowerCase()}`);
    return entry?.state === 'star';
  }
}

/**
 * Display label for a partial / lower-bound count (report §4/§8).
 * Zero shows no numeral: "0" would falsely claim a global total of zero
 * when the node may simply not have met any starrer yet. A positive count
 * is a lower bound ("N+"), never a global total.
 */
export function formatStarCount(count: number): string {
  if (count <= 0) return '';
  return `${count}+`;
}
