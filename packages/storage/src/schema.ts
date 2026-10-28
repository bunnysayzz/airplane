// SPDX-License-Identifier: Apache-2.0
// Frozen SQLite schema (blueprint Appendix D). Applied by OpSqliteStore.migrate().
// Do not edit in place: schema changes require a new numbered migration.
//
// Reserved, currently unused tables (verified: no store method reads or
// writes them, and upsertPeer has no app caller): peers, sync_state,
// seen, frag_buf, logs. They are kept for existing installs (dropping
// tables is not worth the migration risk for zero runtime cost beyond
// write overhead), but their indexes are dropped in MIGRATION_006 and
// no new code should read them. upsertPeer always writes NULL for
// mtu/platform because PeerInfo carries neither field; fixing that
// needs a PeerInfo type change and is deferred until peers are wired up.

export const MIGRATION_001 = `PRAGMA journal_mode = WAL;
CREATE TABLE events(
  id         BLOB PRIMARY KEY,
  pubkey     BLOB NOT NULL,
  kind       INTEGER NOT NULL CHECK(kind IN (1,2,3)),
  created_at INTEGER NOT NULL,
  geohash    TEXT NOT NULL CHECK(length(geohash)=5),
  tags       BLOB NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  sig        BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX idx_events_feed   ON events(kind, geohash, created_at DESC);
CREATE INDEX idx_events_expiry ON events(expires_at);
CREATE INDEX idx_events_pubkey ON events(pubkey, created_at DESC);
CREATE TABLE receipts(
  pubkey     BLOB NOT NULL,
  post_id    BLOB NOT NULL,
  day_bucket INTEGER NOT NULL,
  event_id   BLOB NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(pubkey, post_id, day_bucket)
);
CREATE INDEX idx_receipts_post ON receipts(post_id);
CREATE TABLE view_counts(
  post_id    BLOB PRIMARY KEY,
  views      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE peers(
  peer_id    TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  rssi       INTEGER,
  mtu        INTEGER,
  platform   TEXT CHECK(platform IN ('ios','android'))
);
CREATE INDEX idx_peers_seen ON peers(last_seen);
CREATE TABLE sync_state(
  peer_id       TEXT PRIMARY KEY,
  last_hello_at INTEGER,
  cursor_ts     INTEGER
);
CREATE TABLE seen(
  msg_tag BLOB PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
CREATE INDEX idx_seen_at ON seen(seen_at);
CREATE TABLE frag_buf(
  msg_tag     BLOB NOT NULL,
  idx         INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  data        BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(msg_tag, idx)
);
CREATE TABLE logs(
  ts    INTEGER NOT NULL,
  level TEXT NOT NULL,
  tag   TEXT NOT NULL,
  msg   TEXT NOT NULL
);
CREATE INDEX idx_logs_ts ON logs(ts);
`;

/**
 * MIGRATION_002 - World confirmation tracking (hybrid single-feed plan §4).
 *
 * `world_confirmed` records event IDs observed on at least one Nostr relay.
 * Client-side only: never part of the signed payload, never relayed.
 * Confirmation is sticky - there is no un-confirm path by design.
 */
export const MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS world_confirmed(
  event_id     BLOB PRIMARY KEY,
  confirmed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_confirmed_at ON world_confirmed(confirmed_at);
`;

/**
 * MIGRATION_003 - Durable tombstones (tombstone-wins deletion).
 *
 * `tombstones` is the source of truth for deletions; the old in-memory
 * pending-tombstone map was lost on restart, resurrecting deleted posts.
 * One row per (target post, tombstone author). A zero-length author blob
 * X'' is the 'any' sentinel armed by the trusted markDeleted primitive
 * (which cannot know the tombstone's author): it applies to whatever post
 * arrives with that id. Rows armed by kind-3 ingress carry the tombstone
 * author's pubkey and are honored only when it matches the post's author.
 */
export const MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE tombstones(target_id BLOB NOT NULL, author BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(target_id, author));
CREATE INDEX idx_tombstones_target ON tombstones(target_id);
`;

/**
 * MIGRATION_004 - Durable stars (T17).
 *
 * `star_events` stores every verified kind-4 star/unstar event this node
 * has accepted (applied, superseded, or held pending), keyed by event id,
 * so the star counter rebuilds exactly across restarts instead of
 * repopulating only from re-arriving flood/relay traffic. The full signed
 * event is stored (same column layout as `events` minus the kind CHECK,
 * which would reject kind 4) so replay through the counter re-derives
 * latest-wins state, dedup, and pending queues without new logic.
 * `star_known_posts` records post ids marked known for star purposes, so
 * pending stars flush to the right posts after a restart.
 * Client-side only: never part of a signed payload, never relayed.
 * Stars are display-only; no ranking input lives here.
 */
export const MIGRATION_004 = `
CREATE TABLE IF NOT EXISTS star_events(
  event_id   BLOB PRIMARY KEY,
  pubkey     BLOB NOT NULL,
  target_id  BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  geohash    TEXT NOT NULL,
  tags       BLOB NOT NULL,
  content    TEXT NOT NULL,
  sig        BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_star_events_target ON star_events(target_id, created_at);
CREATE TABLE IF NOT EXISTS star_known_posts(
  post_id BLOB PRIMARY KEY
);
`;

/**
 * MIGRATION_005 - Durable reshare events (T19).
 *
 * `reshare_events` holds kind-5 reshare/unreshare events apart from the
 * `events` table, whose CHECK forbids kind 5. Keeping them separate means
 * reshare rows can never leak into the kind-1-only feed query or the
 * World-sync unconfirmed set, and no existing table is rebuilt. The
 * `target_id` column is the original post id from the event's `e` tag,
 * extracted at save time so rehydration never has to parse tags.
 *
 * Numbered 005 because MIGRATION_004 already owns the star tables
 * (T17 landed first); both tracks' migrations run in version order.
 */
export const MIGRATION_005 = `
CREATE TABLE IF NOT EXISTS reshare_events(
  id         BLOB PRIMARY KEY,
  pubkey     BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  geohash    TEXT NOT NULL,
  target_id  BLOB NOT NULL,
  tags       BLOB NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  sig        BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reshare_events_target ON reshare_events(target_id);
`;

/**
 * MIGRATION_006 - Feed query index matching the real filter and sort.
 *
 * The feed query filters kind = 1, deleted = 0, expires_at > now,
 * geohash IN (cells), and sorts by created_at DESC, id DESC, but the
 * only feed index was (kind, geohash, created_at DESC): no id tiebreak
 * and no deleted/expiry coverage. This additive index matches the sort
 * exactly. Honest limit, kept in the comment on purpose: with a
 * multi-value IN list SQLite still cannot walk one index in global
 * created_at order across cells, so a cross-cell sort before LIMIT may
 * remain; the index removes the per-cell sort and the tiebreak gap.
 * The old index is kept: dropping it waits on EXPLAIN proof on a
 * realistic database that the new one is used.
 */
export const MIGRATION_006 = `
CREATE INDEX IF NOT EXISTS idx_events_feed_v2 ON events(kind, geohash, created_at DESC, id DESC);
DROP INDEX IF EXISTS idx_peers_seen;
DROP INDEX IF EXISTS idx_seen_at;
DROP INDEX IF EXISTS idx_logs_ts;
DROP INDEX IF EXISTS idx_world_confirmed_at;
`;
