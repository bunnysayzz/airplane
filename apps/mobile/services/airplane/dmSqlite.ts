// SPDX-License-Identifier: Apache-2.0
// SQLite DM store (R5): DmStorePort over the app's op-sqlite database
// port, on SEPARATE dm_* tables, never the post tables.
//
// Why a separate file from the transport package: the transport package
// ships to React Native and cannot import the native op-sqlite driver;
// it defines DmStorePort, and this app-layer adapter implements it over
// the generic DatabasePort (exec/query), exactly like sqlite.ts does for
// posts. The same airplane.db file is used, so conversations live next to
// posts but in their own tables.
//
// Sealed at rest: rows hold sealed payloads plus the sendable envelope
// (ephemeral pubkey header, recipient, sealed payload, no plaintext).
// The envelope is what lets an outbox retry after a restart re-send the
// identical bytes, and what lets an incoming message decrypt on read
// after a restart. Outgoing plaintext is never written here: after a
// restart an own sent message shows the placeholder, by design (see the
// R5 note at the bottom of dmService.ts).
//
// Migration is lazy and idempotent (CREATE TABLE IF NOT EXISTS, run once
// per store instance before any operation). A failed migration fails the
// operation with the error — never a silent fall back to MemoryDmStore,
// which would lose conversations.

import type { DatabasePort } from '@airplane/storage';
import {
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
  last_direction TEXT
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  peer_hex TEXT NOT NULL,
  direction TEXT NOT NULL,
  sealed TEXT NOT NULL,
  envelope_json TEXT,
  created_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_messages_peer_idx ON dm_messages (peer_hex, created_at_ms);
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
}

interface MessageDbRow {
  id: string;
  peer_hex: string;
  direction: string;
  sealed: string;
  envelope_json: string | null;
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
  return {
    peerHex: row.peer_hex,
    state: row.state as DmConversationRow['state'],
    muted: row.muted === 1,
    ignored: row.ignored === 1,
    unread: row.unread,
    lastMessageAtMs: row.last_message_at_ms,
    lastSealed: row.last_sealed,
    lastDirection: row.last_direction as DmConversationRow['lastDirection'],
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
    nextAttemptAtMs: row.next_attempt_at_ms,
  };
  const envelope = parseEnvelope(row.envelope_json);
  if (envelope) message.envelope = envelope;
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
        (peer_hex, state, muted, ignored, unread, last_message_at_ms, last_sealed, last_direction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_hex) DO UPDATE SET
        state = excluded.state, muted = excluded.muted, ignored = excluded.ignored,
        unread = excluded.unread, last_message_at_ms = excluded.last_message_at_ms,
        last_sealed = excluded.last_sealed, last_direction = excluded.last_direction`,
      [c.peerHex, c.state, c.muted ? 1 : 0, c.ignored ? 1 : 0, c.unread, c.lastMessageAtMs, c.lastSealed, c.lastDirection],
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
  }

  async addMessage(m: DmMessageRow): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      `INSERT INTO dm_messages
        (id, peer_hex, direction, sealed, envelope_json, created_at_ms, status, attempts, next_attempt_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.id, m.peerHex, m.direction, m.sealed, m.envelope ? JSON.stringify(m.envelope) : null, m.createdAtMs, m.status, m.attempts, m.nextAttemptAtMs],
    );
  }

  async updateMessage(m: DmMessageRow): Promise<void> {
    await this.ensureMigrated();
    await this.db.exec(
      `UPDATE dm_messages SET peer_hex = ?, direction = ?, sealed = ?, envelope_json = ?,
        created_at_ms = ?, status = ?, attempts = ?, next_attempt_at_ms = ?
       WHERE id = ?`,
      [m.peerHex, m.direction, m.sealed, m.envelope ? JSON.stringify(m.envelope) : null, m.createdAtMs, m.status, m.attempts, m.nextAttemptAtMs, m.id],
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
}
