// SPDX-License-Identifier: Apache-2.0
// PostCard - the Airplane feed card, built on panelui's Post compound
// (see components/ui/post.tsx for the vendored, adapted source).
//
// The card is presentational: it takes a PostCardModel view-model (mapped from
// real mesh events by another worker) and renders author, body and the views
// count. Views are the hero stat - this product ranks by views, so there are
// deliberately no hearts, reposts, bookmarks or follow buttons.
import React from 'react';
import { Text } from 'react-native';
import { Post } from './ui/post';
import { EyeIcon } from './ui/eyeIcon';
import { useTheme } from '../src/theme/themeContext';

export interface PostCardModel {
  /** hex event hash (stable key) */
  eventId: string;
  /** e.g. "anon·a3f9" - short pseudonym, NEVER a real name/handle */
  authorLabel: string;
  /** post text */
  body: string;
  /** epoch ms, for relative time */
  createdAtMs: number;
  /** origin geohash tag, e.g. "tdr1v" */
  geohash: string;
  /** distinct viewer count */
  views: number;
  /** ranking score (not computed here) */
  score: number;
  /** true when confirmed on a Nostr relay (World) */
  worldConfirmed: boolean;
}

export interface PostCardProps {
  post: PostCardModel;
  onPress?: (eventId: string) => void;
}

/**
 * Compact relative time: "now", "45s", "3m", "2h", "5d", "3w", "4mo", "1y".
 * No date library - the mesh feed only needs coarse recency.
 */
export function timeAgo(createdAtMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function PostCard({ post, onPress }: PostCardProps) {
  const { type } = useTheme();

  return (
    <Post
      onPress={onPress ? () => onPress(post.eventId) : undefined}
      accessibilityLabel={`Post by ${post.authorLabel}, ${post.views} views`}
    >
      <Post.Header>
        <Post.Author
          name={post.authorLabel}
          handle={`#${post.geohash}`}
          timestamp={timeAgo(post.createdAtMs)}
        />
        {post.worldConfirmed ? (
          <Post.Action>
            <Text
              style={[type.meta, { fontSize: 10, opacity: 0.6 }]}
              accessibilityLabel="Reached the world network"
            >
              🌐
            </Text>
          </Post.Action>
        ) : null}
      </Post.Header>
      <Post.Body>{post.body}</Post.Body>
      <Post.Footer>
        <Post.Stat icon={EyeIcon} value={post.views} />
      </Post.Footer>
    </Post>
  );
}
