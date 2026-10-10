// SPDX-License-Identifier: Apache-2.0
// PostCardModel — the single source of truth for the card view-model.
// The post card UI (separate worker) builds against this exact shape.

export interface PostCardModel {
  /** Hex-encoded event id (64 lowercase hex chars). */
  eventId: string;
  /** Post creation time, milliseconds since epoch (card formats relative time). */
  createdAtMs: number;
  /** Pseudonymous author label, e.g. "anon·a3f9". */
  authorLabel: string;
  /** NFC-normalized post body, 1..280 chars. */
  body: string;
  /** Geohash-5 cell the post was published in. */
  geohash: string;
  /** Deduplicated view-receipt count. */
  views: number;
  /** Protocol ranking score (higher sorts first). */
  score: number;
  /** True when the post carries the signed ["uplink","1"] opt-in tag. */
  uplinked: boolean;
}
