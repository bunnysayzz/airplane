// SPDX-License-Identifier: Apache-2.0
// SQLite DM store: DmStorePort over the app's op-sqlite database port, on
// SEPARATE dm_* tables, never the post tables.
//
// Why a separate file from the transport package: the transport package
// ships to React Native and cannot import the native op-sqlite driver;
// it defines DmStorePort, and this app-layer adapter implements it over
// the generic DatabasePort (exec/query), exactly like sqlite.ts does for
// posts. The same airplane.db file is used, so conversations live next to
// posts but in their own tables.
//
// Sealed at rest, with one deliberate exception. Incoming rows hold sealed
// payloads plus the sendable envelope (ephemeral pubkey header, recipient,
// sealed payload, no plaintext): the envelope is what lets an incoming
// message decrypt on read after a restart, and what lets an outbox retry
// after a restart re-send the identical bytes. Outgoing rows additionally
// persist their own plaintext in plain_text, so the sender thread still
// renders after a restart. That plaintext is the sender's own words, in
// the same database file that already holds feed posts in plaintext; it
// is never set on incoming rows, whose plaintext stays decrypt-on-read
// only. Delivery ids and ack proofs are one-way values (a random id, an
// HMAC output): persisting them cannot decrypt anything.
//
// No migration from an older dm_* schema is needed: the shipped store on
// main was MemoryDmStore, so no on-device dm_* tables exist to migrate.
// Migration is lazy and idempotent (CREATE TABLE IF NOT EXISTS, run once
// per store instance before any operation). A failed migration fails the
// operation with the error, never a silent fall back to MemoryDmStore,
// which would lose conversations.

import type { DatabasePort } from '@airplane/storage';
import {
  DM_MAX_MESSAGES_PER_CONVERSATION,
  type DmConversationRow,
  type DmMessageRow,
  type DmStorePort,
} from '@airplane/transport';
import type { DmEnvelope } from '@airplane/transport';

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS dm_conversations (
  peer_hex TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  muted INTEGER NOT NULL,
  ignored INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  last_message_at_ms INTEGER NOT NULL,
  last_sealed TEXT,
  last_direction TEXT,
  prior_state TEXT
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  peer_hex TEXT NOT NULL,
  direction TEXT NOT NULL,
  sealed TEXT NOT NULL,
  envelope_json TEXT,
  plain_text TEXT,
  delivery_id TEXT UNIQUE,
  ack_proof TEXT,
  sender_created_at_sec INTEGER,
  seq INTEGER,
  mesh_attempts INTEGER NOT NULL DEFAULT 0,
  relay_republish_attempts INTEGER NOT NULL DEFAULT 0,
  ack_sent INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_messages_peer_idx ON dm_messages (peer_hex, created_at_ms);
CREATE TABLE IF NOT EXISTS dm_seen (
  delivery_id TEXT PRIMARY KEY,
  peer_hex TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL
);
`;

interface ConversationDbRow {
  peer_hex: string;
  state: string;
  muted: number;
  ignored: number;
  unread: number;
  last_message_at_ms: number;
  last_sealed: string | null;
  last_direction: string | null;
  prior_state: string | null;
}

interface MessageDbRow {
  id: string;
  peer_hex: string;
  direction: string;
  sealed: string;
  envelope_json: string | null;
  plain_text: string | null;
  delivery_id: string | null;
  ack_proof: string | null;
  sender_created_at_sec: number | null;
  seq: number | null;
  mesh_attempts: number;
  relay_republish_attempts: number | null;
  ack_sent: number | null;
  created_at_ms: number;
  status: string;
  attempts: number;
  next_attempt_at_ms: number;
}

function parseEnvelope(json: string | null): DmEnvelope | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as DmEnvelope;
    if (
      typeof parsed.ephemeralPubkeyHex !== 'string' ||
      typeof parsed.recipientHex !== 'string' ||
      typeof parsed.sealed !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function conversationFromRow(row: ConversationDbRow): DmConversationRow {
  const prior = row.prior_state === 'inbox' || row.prior_state === 'request' ? row.prior_state : null;
  return {
    peerHex: row.peer_hex,
    state: row.state as DmConversationRow['state'],
    muted: row.muted === 1,
    ignored: row.ignored === 1,
    unread: row.unread,
    lastMessageAtMs: row.last_message_at_ms,
    lastSealed: row.last_sealed,
    lastDirection: row.last_direction as DmConversationRow['lastDirection'],
    priorState: prior,
  };
}

function messageFromRow(row: MessageDbRow): DmMessageRow {
  const message: DmMessageRow = {
    id: row.id,
    peerHex: row.peer_hex,
    direction: row.direction as DmMessageRow['direction'],
    sealed: row.sealed,
    createdAtMs: row.created_at_ms,
    status: row.status as DmMessageRow['status'],
    attempts: row.attempts,
    meshAttempts: row.mesh_attempts,
    relayRepublishAttempts: row.relay_republish_attempts ?? 0,
    ackSent: row.ack_sent === 1,
    nextAttemptAtMs: row.next_attempt_at_ms,
  };
  const envelope = parseEnvelope(row.envelope_json);
  if (envelope) message.envelope = envelope;
  // Plain text is stored for outgoing rows only; a non-null value on an
  // incoming row would be a corrupt store, so it is dropped on read.
  if (row.direction === 'out' && row.plain_text !== null) message.plainText = row.plain_text;
  if (row.delivery_id !== null) message.deliveryId = row.delivery_id;
  if (row.ack_proof !== null) message.ackProof = row.ack_proof;
  if (row.sender_created_at_sec !== null) message.senderCreatedAtSec = row.sender_created_at_sec;
  if (row.seq !== null && row.seq !== undefined) message.seq = row.seq;
  return message;
}

export class SqliteDmStore implements DmStorePort {
  private readonly db: DatabasePort;
  private ready: Promise<void> | null = null;

  constructor(db: DatabasePort) {
    this.db = db;
  }

  private ensureMigrated(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        for (const statement of MIGRATION_SQL.split(';')) {
          const sql = statement.trim();
          if (sql) await this.db.exec(sql);
        }
        // Upgrade for tables created before the rank 1 and rank 9
        // columns: SQLite has no ADD COLUMN IF NOT EXISTS, so a
        // duplicate-column error means the column is already there
        // and is ignored. Any other error still fails the migration.
        for (const sql of [
          'ALTER TABLE dm_messages ADD COLUMN relay_republish_attempts INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE dm_messages ADD COLUMN ack_sent INTEGER NOT NULL DEFAULT 0',
          'ALTER TABLE dm_messages ADD COLUMN seq INTEGER',
        ]) {
          try {
            await this.db.exec(sql);
          } catch (e) {
            if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
          }
        }
      })();
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  async upsertConversation(c: DmConversationRow): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      `INSERT INTO dm_conversations
        (peer_hex, state, muted, ignored, unread, last_message_at_ms, last_sealed, last_direction, prior_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_hex) DO UPDATE SET
        state = excluded.state, muted = excluded.muted, ignored = excluded.ignored,
        unread = excluded.unread, last_message_at_ms = excluded.last_message_at_ms,
        last_sealed = excluded.last_sealed, last_direction = excluded.last_direction,
        prior_state = excluded.prior_state`,
      [
        c.peerHex,
        c.state,
        c.muted ? 1 : 0,
        c.ignored ? 1 : 0,
        c.unread,
        c.lastMessageAtMs,
        c.lastSealed,
        c.lastDirection,
        c.priorState ?? null,
      ],
    );
  }

  async getConversation(peerHex: string): Promise<DmConversationRow | null> {
    await this.ensureMigrated();
    const rows = await this.db.query<ConversationDbRow>('SELECT * FROM dm_conversations WHERE peer_hex = ?', [peerHex]);
    return rows.length > 0 ? conversationFromRow(rows[0]) : null;
  }

  async listConversations(): Promise<DmConversationRow[]> {
    await this.ensureMigrated();
    const rows = await this.db.query<ConversationDbRow>('SELECT * FROM dm_conversations', []);
    return rows.map(conversationFromRow);
  }

  async deleteConversation(peerHex: string): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec('DELETE FROM dm_conversations WHERE peer_hex = ?', [peerHex]);
    await this.db.exec('DELETE FROM dm_messages WHERE peer_hex = ?', [peerHex]);
    // dm_seen is deliberately kept: a relay replay must not resurrect a
    // conversation the user deleted from this device.
  }

  async addMessage(m: DmMessageRow): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      `INSERT INTO dm_messages
        (id, peer_hex, direction, sealed, envelope_json, plain_text, delivery_id, ack_proof,
         sender_created_at_sec, seq, mesh_attempts, relay_republish_attempts, ack_sent,
         created_at_ms, status, attempts, next_attempt_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        m.id,
        m.peerHex,
        m.direction,
        m.sealed,
        m.envelope ? JSON.stringify(m.envelope) : null,
        m.direction === 'out' ? (m.plainText ?? null) : null,
        m.deliveryId ?? null,
        m.ackProof ?? null,
        m.senderCreatedAtSec ?? null,
        m.seq ?? null,
        m.meshAttempts ?? 0,
        m.relayRepublishAttempts ?? 0,
        m.ackSent === true ? 1 : 0,
        m.createdAtMs,
        m.status,
        m.attempts,
        m.nextAttemptAtMs,
      ],
    );
    // Per-conversation retention, matching the memory store cap: drop
    // everything past the newest DM_MAX_MESSAGES_PER_CONVERSATION rows.
    await this.db.exec(
      `DELETE FROM dm_messages WHERE peer_hex = ? AND id IN (
         SELECT id FROM dm_messages WHERE peer_hex = ?
         ORDER BY created_at_ms DESC LIMIT -1 OFFSET ?
       )`,
      [m.peerHex, m.peerHex, DM_MAX_MESSAGES_PER_CONVERSATION],
    );
  }

  async updateMessage(m: DmMessageRow): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      `UPDATE dm_messages SET peer_hex = ?, direction = ?, sealed = ?, envelope_json = ?,
        plain_text = ?, delivery_id = ?, ack_proof = ?, sender_created_at_sec = ?,
        seq = ?, mesh_attempts = ?, relay_republish_attempts = ?, ack_sent = ?,
        created_at_ms = ?, status = ?, attempts = ?, next_attempt_at_ms = ?
       WHERE id = ?`,
      [
        m.peerHex,
        m.direction,
        m.sealed,
        m.envelope ? JSON.stringify(m.envelope) : null,
        m.direction === 'out' ? (m.plainText ?? null) : null,
        m.deliveryId ?? null,
        m.ackProof ?? null,
        m.senderCreatedAtSec ?? null,
        m.seq ?? null,
        m.meshAttempts ?? 0,
        m.relayRepublishAttempts ?? 0,
        m.ackSent === true ? 1 : 0,
        m.createdAtMs,
        m.status,
        m.attempts,
        m.nextAttemptAtMs,
        m.id,
      ],
    );
  }

  async listMessages(peerHex: string): Promise<DmMessageRow[]> {
    await this.ensureMigrated();
    const rows = await this.db.query<MessageDbRow>(
      'SELECT * FROM dm_messages WHERE peer_hex = ? ORDER BY created_at_ms ASC',
      [peerHex],
    );
    return rows.map(messageFromRow);
  }

  async deleteMessages(peerHex: string): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec('DELETE FROM dm_messages WHERE peer_hex = ?', [peerHex]);
  }

  async lastInboundCreatedAtSec(): Promise<number | null> {
    await this.ensureMigrated();
    const rows = await this.db.query<{ latest: number | null }>(
      'SELECT MAX(sender_created_at_sec) AS latest FROM dm_messages WHERE direction = ?',
      ['in'],
    );
    return rows.length > 0 ? rows[0].latest : null;
  }

  async hasSeenDelivery(deliveryId: string): Promise<boolean> {
    await this.ensureMigrated();
    const rows = await this.db.query<{ delivery_id: string }>('SELECT delivery_id FROM dm_seen WHERE delivery_id = ?', [
      deliveryId,
    ]);
    return rows.length > 0;
  }

  async markSeenDelivery(deliveryId: string, peerHex: string): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      'INSERT OR IGNORE INTO dm_seen (delivery_id, peer_hex, seen_at_ms) VALUES (?, ?, ?)',
      [deliveryId, peerHex, Date.now()],
    );
  }

  async findMessageByDeliveryId(deliveryId: string): Promise<DmMessageRow | null> {
    await this.ensureMigrated();
    const rows = await this.db.query<MessageDbRow>('SELECT * FROM dm_messages WHERE delivery_id = ? AND direction = ?', [
      deliveryId,
      'out',
    ]);
    return rows.length > 0 ? messageFromRow(rows[0]) : null;
  }
}
