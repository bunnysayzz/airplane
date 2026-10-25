// SPDX-License-Identifier: Apache-2.0
// PostCardModel - the single source of truth for the card view-model.
// The post card UI (separate worker) builds against this exact shape.

export interface PostCardModel {
  /** Hex-encoded event id (64 lowercase hex chars). */
  eventId: string;
  /** Post creation time, milliseconds since epoch (card formats relative time). */
  createdAtMs: number;
  /** Pseudonymous author label, e.g. "quiet fox·a3f9". */
  authorLabel: string;
  /** NFC-normalized post body, 1..280 chars. */
  body: string;
  /** Geohash-5 cell the post was published in. */
  geohash: string;
  /** Deduplicated view-receipt count. */
  views: number;
  /** Protocol ranking score (higher sorts first). */
  score: number;
  /** True when the post's event ID has been confirmed on a Nostr relay. */
  worldConfirmed: boolean;
  /** Author mesh pubkey hex (DM address). Absent for synthetic/test cards. */
  authorPubkeyHex?: string;
  // --- RESHARE (delimited) ---
  /** partial, lower-bound reshare count seen by this device */
  reshares: number;
  /** true when this device's key currently reshares this post */
  resharedByMe: boolean;
  /** memorable anonymous label of the most recent resharer, if any */
  latestResharerLabel?: string;
  // --- RESHARE (delimited end) ---
  // --- STAR MVP (delimited; merge-safe: additive fields only) ---
  /** Distinct starrers seen for this post (per-node partial view). */
  stars: number;
  /** Partial-count label: "N+" when stars > 0, "" when none seen. */
  starLabel: string;
  /** True when the device's own latest star state for this post is "star". */
  starredByMe: boolean;
}
