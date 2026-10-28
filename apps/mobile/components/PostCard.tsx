// SPDX-License-Identifier: Apache-2.0
// PostCard - the Airplane feed card, built on panelui's Post compound
// (see components/ui/post.tsx for the vendored, adapted source).
//
// The card is presentational: it takes a PostCardModel view-model (mapped from
// real mesh events by another worker) and renders author, body and the views
// count. Views are the hero stat - this product ranks by views, so there are
// deliberately no hearts, reposts, bookmarks or follow buttons.
import React, { useRef } from 'react';
import { Pressable, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Post } from './ui/post';
import { EyeIcon } from './ui/eyeIcon';
import { useTheme } from '../src/theme/themeContext';
import { formatCompact } from '../src/lib/format';
import { isWithinWindow } from '../src/lib/navGuard';

export interface PostCardModel {
  /** hex event hash (stable key) */
  eventId: string;
  /** e.g. "quiet fox·a3f9" - short pseudonym, NEVER a real name/handle */
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
  stars?: number;
  /** Partial-count label: "N+" when stars > 0, "" when none seen. */
  starLabel?: string;
  /** True when the device's own latest star state for this post is "star". */
  starredByMe?: boolean;
}

export interface PostCardProps {
  post: PostCardModel;
  onPress?: (eventId: string) => void;
  /** STAR MVP: fired when the star button is tapped (feed/detail wire it). */
  onStar?: (eventId: string) => void;
  /** DM P1: open a DM with the post author. Only rendered when the author key is known. */
  onMessage?: (authorPubkeyHex: string) => void;
  /** RESHARE: called with the ORIGINAL post id when the reshare stat is tapped */
  onReshare?: (eventId: string) => void;
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

// --- RESHARE (delimited): reshare glyph honouring the Post.Stat icon contract.
export function ReshareIcon({ size = 17, color }: { size?: number; color?: string; filled?: boolean }) {
  return <Ionicons name="repeat" size={size} color={color} />;
}

export function PostCardInner({ post, onPress, onStar, onMessage, onReshare }: PostCardProps) {
  const { type, colors } = useTheme();

  // Inner-action guard: the card is a Pressable wrapping inner Pressables
  // (Message, star, reshare). React Native gives the inner responder the
  // tap, so inner taps do not navigate in practice, but a platform
  // double-fire must never open the thread: a card press within 500ms of
  // an inner action is treated as that action, not a navigation.
  const lastActionAt = useRef(0);
  const markAction = () => {
    lastActionAt.current = Date.now();
  };
  const handleCardPress = onPress
    ? () => {
        if (!isWithinWindow(lastActionAt.current, Date.now(), 500)) onPress(post.eventId);
      }
    : undefined;

  return (
    <Post
      onPress={handleCardPress}
      accessibilityLabel={`Post by ${post.authorLabel}, ${post.views} views, ${post.reshares} reshares`}
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
        <Post.Stat icon={EyeIcon} value={formatCompact(post.views)} />
        {onMessage && post.authorPubkeyHex ? (
          <Pressable
            onPress={() => {
              markAction();
              onMessage(post.authorPubkeyHex as string);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Message ${post.authorLabel}`}
          >
            <Text style={[type.meta, { color: colors.accentText }]}>Message</Text>
          </Pressable>
        ) : null}
        {/* --- RESHARE (delimited): collapsed cluster on the ORIGINAL card.
            No second card is ever created for a reshare; the count + latest
            resharer attribution live here. Count is a partial lower bound. */}
        <Post.Stat
          icon={ReshareIcon}
          value={formatCompact(post.reshares)}
          tone="repost"
          active={post.resharedByMe}
          onPress={
            onReshare
              ? () => {
                  markAction();
                  onReshare(post.eventId);
                }
              : undefined
          }
          accessibilityLabel={
            post.resharedByMe
              ? 'You reshared this post. Tap to unreshare.'
              : `Reshare this post. ${post.reshares} reshares seen.`
          }
        />
        {post.latestResharerLabel ? (
          <Text style={[type.meta, { fontSize: 10, opacity: 0.6 }]}>
            ↻ {post.latestResharerLabel}
          </Text>
        ) : null}
        {/* --- RESHARE (delimited end) --- */}
        {/* --- STAR MVP (delimited) --- */}
        <Post.Stat
          active={post.starredByMe ?? false}
          tone="like"
          value={post.starLabel ? post.starLabel : undefined}
          onPress={
            onStar
              ? () => {
                  markAction();
                  onStar(post.eventId);
                }
              : undefined
          }
          accessibilityLabel={
            post.starredByMe ? 'Unstar this post' : 'Star this post'
          }
        >
          <Text style={[type.meta, { fontSize: 14 }]}>
            {post.starredByMe ? '★' : '☆'}
          </Text>
        </Post.Stat>
      </Post.Footer>
    </Post>
  );
}

// Memoized: the feed re-renders rows on every Timeline state change otherwise.
export const PostCard = React.memo(PostCardInner);
PostCard.displayName = 'PostCard';
