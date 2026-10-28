// SPDX-License-Identifier: Apache-2.0
// Reshare counting: same model as stars (research report §4), applied to
// kind-5 reshare events.
//
// 1. Dedup by signed event id across transports: an event already seen
//    (verified) is never processed twice, however many paths delivered it.
// 2. ONE counted reshare per (resharer pubkey, original post). Counting keys
//    ONLY on the original post id — never on a wrapper/via id.
// 3. Latest-wins for undo, with retained superseded events: per
//    (pubkey, post) the newest event by (created_at, event-id-hex) decides
//    the state (reshared vs unreshared). Older events arriving late are
//    retained but cannot resurrect a superseded state.
// 4. Verify before counting: the caller supplies a verify function (ed25519
//    over the recomputed id, e.g. verifyEvent). An unverified event is
//    dropped outright — it is not counted, not held pending, and not added
//    to the seen-set, so a genuine event with the same id can still count
//    later (id binds the fields, not the signature).
// 5. Pending: a reshare for a post this node does not yet have is HELD, not
//    dropped. It applies the moment the post is marked known via
//    `markPostKnown`. A node that lacks the post must never have the post
//    pushed at it by the resharer — pull-on-demand is the transport's job,
//    not the counter's.
// 6. Counts are partial lower bounds: "this device has seen N distinct
//    reshares". They are never presented as a global total.
//
// Feed effect (enforced by consumers, guaranteed here by construction):
// this counter produces counts per original post id only. It never creates
// a feed item: a reshare never duplicates the feed card. Feed listing stays
// kind-1-only (see @airplane/storage listFeed), and the card renders the
// cluster (count + latest resharer) on the original post's card.
//
// Ranking is untouched: reshare counts are display-only, view-based ranking
// stays as-is. No proof-of-work and no relay curation in this implementation.

import { EVENT_KIND_RESHARE, type Hex64, type SignedEvent } from '../events/types';
import { toHex } from '../hex';
import { isUnreshare, reshareTargetId } from '../payloads/reshares';

/** Result of offering an event to the counter. */
export type ReshareAddResult =
  | 'counted'
  | 'pending'
  | 'superseded'
  | 'duplicate'
  | 'ignored';

/** Collapsed reshare cluster for one original post, as rendered on its card. */
export interface ReshareCluster {
  /** Original post id (hex). */
  postId: Hex64;
  /** Distinct pubkeys currently resharing (partial, lower-bound count). */
  count: number;
  /** Currently-resharing pubkeys (hex), most-recent-first by (created_at, id). */
  resharers: Hex64[];
  /** Most recent active resharer (hex), or null when count is 0. */
  latestResharer: Hex64 | null;
}

interface PerAuthorState {
  /** Newest event seen for this (pubkey, post), by (created_at, idHex). */
  latestCreatedAt: number;
  latestIdHex: Hex64;
  /** Whether the latest event is an active reshare (false = unreshared). */
  active: boolean;
}

function newerThan(
  createdAt: number,
  idHex: Hex64,
  state: PerAuthorState,
): boolean {
  if (createdAt !== state.latestCreatedAt) return createdAt > state.latestCreatedAt;
  return idHex > state.latestIdHex;
}

export class ReshareCounter {
  /** Verified event ids already processed (cross-transport dedup). */
  private readonly seenEventIds = new Set<Hex64>();
  /** All verified events, retained so late arrivals resolve correctly. */
  private readonly events = new Map<Hex64, SignedEvent>();
  /** Latest state per (pubkey, post). Key: `${pubkeyHex}:${postIdHex}`. */
  private readonly latest = new Map<string, PerAuthorState>();
  /**
   * Per-post index into `latest`: postHex -> state keys for that post.
   * cluster() reads only this post's entries instead of scanning every
   * (pubkey, post) state on every card.
   */
  private readonly latestByPost = new Map<Hex64, Set<string>>();
  /** Post ids this node holds (originals). Reshares for others stay pending. */
  private readonly knownPosts = new Set<Hex64>();
  /** Pending reshare event ids per unknown post id. */
  private readonly pending = new Map<Hex64, Set<Hex64>>();

  private static stateKey(pubkeyHex: Hex64, postIdHex: Hex64): string {
    return `${pubkeyHex}:${postIdHex}`;
  }

  /** Mark an original post as known (arrived locally). Pending reshares apply. */
  markPostKnown(postIdHex: Hex64): void {
    this.knownPosts.add(postIdHex.toLowerCase());
    // Pending events were already recorded in `latest` at intake (so their
    // ordering is preserved); knowing the post only flips their visibility
    // via count()/cluster(), which filter on knownPosts. Nothing to replay.
    this.pending.delete(postIdHex.toLowerCase());
  }

  /** True when the node holds this original post. */
  isPostKnown(postIdHex: Hex64): boolean {
    return this.knownPosts.has(postIdHex.toLowerCase());
  }

  /** Number of verified reshare events held pending for unknown posts. */
  pendingCount(): number {
    let n = 0;
    for (const set of this.pending.values()) n += set.size;
    return n;
  }

  /** Event ids held pending for one post (empty when the post is known). */
  pendingFor(postIdHex: Hex64): Hex64[] {
    return [...(this.pending.get(postIdHex.toLowerCase()) ?? [])];
  }

  /**
   * Offer a reshare/unreshare event. Verification runs FIRST: unverified
   * events return 'ignored' and leave no trace. Verified duplicates return
   * 'duplicate'. A verified event older than the author's latest state for
   * the post is retained but returns 'superseded'. Otherwise it becomes the
   * author's latest state and returns 'counted' (post known) or 'pending'
   * (post not yet known — held, never dropped).
   */
  add(event: SignedEvent, verify: (e: SignedEvent) => boolean): ReshareAddResult {
    if (event.kind !== EVENT_KIND_RESHARE) return 'ignored';
    if (!verify(event)) return 'ignored';
    const idHex = toHex(event.id);
    if (this.seenEventIds.has(idHex)) return 'duplicate';
    const target = reshareTargetId(event);
    if (target === undefined) return 'ignored';
    const pubkeyHex = toHex(event.pubkey);

    this.seenEventIds.add(idHex);
    this.events.set(idHex, event);

    const key = ReshareCounter.stateKey(pubkeyHex, target);
    const prev = this.latest.get(key);
    if (prev && !newerThan(event.created_at, idHex, prev)) return 'superseded';
    if (!prev) {
      let keys = this.latestByPost.get(target);
      if (!keys) {
        keys = new Set();
        this.latestByPost.set(target, keys);
      }
      keys.add(key);
    }
    this.latest.set(key, {
      latestCreatedAt: event.created_at,
      latestIdHex: idHex,
      active: !isUnreshare(event),
    });

    if (!this.knownPosts.has(target)) {
      let set = this.pending.get(target);
      if (!set) {
        set = new Set();
        this.pending.set(target, set);
      }
      set.add(idHex);
      return 'pending';
    }
    return 'counted';
  }

  /** Currently-resharing pubkeys for a known post, most-recent-first. */
  private activeResharers(postIdHex: Hex64): Hex64[] {
    const id = postIdHex.toLowerCase();
    if (!this.knownPosts.has(id)) return [];
    const rows: { pubkeyHex: Hex64; createdAt: number; idHex: Hex64 }[] = [];
    for (const key of this.latestByPost.get(id) ?? []) {
      const state = this.latest.get(key);
      if (!state || !state.active) continue;
      const sep = key.indexOf(':');
      const pubkeyHex = key.slice(0, sep);
      rows.push({ pubkeyHex, createdAt: state.latestCreatedAt, idHex: state.latestIdHex });
    }
    rows.sort((a, b) => b.createdAt - a.createdAt || (b.idHex > a.idHex ? 1 : -1));
    return rows.map((r) => r.pubkeyHex);
  }

  /** Collapsed cluster for one original post. Unknown posts report count 0. */
  cluster(postIdHex: Hex64): ReshareCluster {
    const id = postIdHex.toLowerCase();
    const resharers = this.activeResharers(id);
    return {
      postId: id,
      count: resharers.length,
      resharers,
      latestResharer: resharers[0] ?? null,
    };
  }

  /** Partial, lower-bound reshare count for a known post (0 while pending). */
  count(postIdHex: Hex64): number {
    return this.cluster(postIdHex).count;
  }

  /** True when this pubkey's latest state for the post is an active reshare. */
  hasReshared(pubkeyHex: Hex64, postIdHex: Hex64): boolean {
    const state = this.latest.get(
      ReshareCounter.stateKey(pubkeyHex.toLowerCase(), postIdHex.toLowerCase()),
    );
    if (!state || !state.active) return false;
    return this.knownPosts.has(postIdHex.toLowerCase());
  }

  /**
   * Latest event for this (pubkey, post), or null when none seen.
   * Used by the toggle path to step created_at past its own previous
   * event, so a same-second reshare-then-unreshare resolves by intent
   * instead of falling to the id-hex tie-break (same pattern as stars).
   */
  latestFor(postIdHex: Hex64, pubkeyHex: Hex64): SignedEvent | null {
    const state = this.latest.get(
      ReshareCounter.stateKey(pubkeyHex.toLowerCase(), postIdHex.toLowerCase()),
    );
    if (!state) return null;
    return this.events.get(state.latestIdHex) ?? null;
  }

  /** Retained verified events (for debugging / rehydration), by event id. */
  retainedEventCount(): number {
    return this.events.size;
  }
}
