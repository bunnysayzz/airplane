// SPDX-License-Identifier: Apache-2.0
// Feed ranking: views win, recency decays.
//   score = log10(1 + views) / (ageHours + 2) ^ gravity, gravity = 1.5
// Pure functions; the store layer supplies views/createdAt.

import { RANK_GRAVITY, type FeedPost, type SignedEvent, type UnixSec } from '../events/types';

/** Ranking score for a post. Views and age are floored at 0. */
export function scorePost(views: number, ageHours: number, gravity: number = RANK_GRAVITY): number {
  const v = Math.max(0, views);
  const age = Math.max(0, ageHours);
  return Math.log10(1 + v) / Math.pow(age + 2, gravity);
}

/** Age of a post in hours at `nowSec`. */
export function ageHours(createdAt: UnixSec, nowSec: UnixSec): number {
  return Math.max(0, (nowSec - createdAt) / 3600);
}

export interface RankablePost {
  event: SignedEvent;
  views: number;
}

/**
 * Score every post and return FeedPosts sorted highest-score first.
 * Stable for equal scores (insertion order preserved).
 */
export function rankPosts(posts: RankablePost[], nowSec: UnixSec): FeedPost[] {
  return posts
    .map((p) => {
      const age = ageHours(p.event.created_at, nowSec);
      return {
        event: p.event,
        views: p.views,
        score: scorePost(p.views, age),
        ageHours: age,
      } satisfies FeedPost;
    })
    .sort((a, b) => b.score - a.score);
}
