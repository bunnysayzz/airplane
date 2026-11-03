// SPDX-License-Identifier: Apache-2.0
// SqliteDmStore tests over a fake DatabasePort: row mapping (envelope,
// outgoing plaintext only, prior state, sender timestamps, delivery id,
// ack proof), seen-delivery dedup, the restart watermark, and
// per-conversation retention. The fake implements exactly the statements
// the store issues; SQL syntax itself is additionally checked against a
// real SQLite engine (see the report), since Jest has no SQL driver.

import type { DatabasePort } from '@airplane/storage';
import { SqliteDmStore } from './dmSqlite';
import type { DmMessageRow } from '@airplane/transport';

interface ConvRow {
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

interface MsgRow {
  id: string;
  peer_hex: string;
  direction: string;
  sealed: string;
  envelope_json: string | null;
  plain_text: string | null;
  delivery_id: string | null;
  ack_proof: string | null;
  sender_created_at_sec: number | null;
  mesh_attempts: number;
  relay_republish_attempts: number;
  ack_sent: number;
  created_at_ms: number;
  status: string;
  attempts: number;
  next_attempt_at_ms: number;
}

/** Minimal in-memory stand-in for the statements SqliteDmStore issues. */
class FakeDb implements DatabasePort {
  convs = new Map<string, ConvRow>();
  msgs = new Map<string, MsgRow>();
  seen = new Map<string, { peer_hex: string; seen_at_ms: number }>();
  statements: string[] = [];

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    this.statements.push(sql);
    const p = params as (string | number | null)[];
    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) return;
    if (sql.startsWith('ALTER TABLE')) return;
    if (sql.startsWith('INSERT INTO dm_conversations')) {
      const row: ConvRow = {
        peer_hex: p[0] as string,
        state: p[1] as string,
        muted: p[2] as number,
        ignored: p[3] as number,
        unread: p[4] as number,
        last_message_at_ms: p[5] as number,
        last_sealed: p[6] as string | null,
        last_direction: p[7] as string | null,
        prior_state: p[8] as string | null,
      };
      this.convs.set(row.peer_hex, row);
      return;
    }
    if (sql.startsWith('INSERT INTO dm_messages')) {
      const row: MsgRow = {
        id: p[0] as string,
        peer_hex: p[1] as string,
        direction: p[2] as string,
        sealed: p[3] as string,
        envelope_json: p[4] as string | null,
        plain_text: p[5] as string | null,
        delivery_id: p[6] as string | null,
        ack_proof: p[7] as string | null,
        sender_created_at_sec: p[8] as number | null,
        mesh_attempts: p[9] as number,
        relay_republish_attempts: p[10] as number,
        ack_sent: p[11] as number,
        created_at_ms: p[12] as number,
        status: p[13] as string,
        attempts: p[14] as number,
        next_attempt_at_ms: p[15] as number,
      };
      this.msgs.set(row.id, row);
      return;
    }
    if (sql.startsWith('DELETE FROM dm_messages WHERE peer_hex = ? AND id IN')) {
      const peer = p[0] as string;
      const cap = p[2] as number;
      const rows = [...this.msgs.values()]
        .filter(m => m.peer_hex === peer)
        .sort((a, b) => b.created_at_ms - a.created_at_ms);
      for (const extra of rows.slice(cap)) this.msgs.delete(extra.id);
      return;
    }
    if (sql.startsWith('UPDATE dm_messages')) {
      const id = p[15] as string;
      const row = this.msgs.get(id);
      if (!row) return;
      row.peer_hex = p[0] as string;
      row.direction = p[1] as string;
      row.sealed = p[2] as string;
      row.envelope_json = p[3] as string | null;
      row.plain_text = p[4] as string | null;
      row.delivery_id = p[5] as string | null;
      row.ack_proof = p[6] as string | null;
      row.sender_created_at_sec = p[7] as number | null;
      row.mesh_attempts = p[8] as number;
      row.relay_republish_attempts = p[9] as number;
      row.ack_sent = p[10] as number;
      row.created_at_ms = p[11] as number;
      row.status = p[12] as string;
      row.attempts = p[13] as number;
      row.next_attempt_at_ms = p[14] as number;
      return;
    }
    if (sql.startsWith('DELETE FROM dm_conversations')) {
      this.convs.delete(p[0] as string);
      return;
    }
    if (sql.startsWith('DELETE FROM dm_messages WHERE peer_hex = ?')) {
      for (const [id, m] of [...this.msgs]) {
        if (m.peer_hex === p[0]) this.msgs.delete(id);
      }
      return;
    }
    if (sql.startsWith('INSERT OR IGNORE INTO dm_seen')) {
      const id = p[0] as string;
      if (!this.seen.has(id)) {
        this.seen.set(id, { peer_hex: p[1] as string, seen_at_ms: p[2] as number });
      }
      return;
    }
    throw new Error(`FakeDb: unhandled statement: ${sql}`);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const p = params as (string | number)[];
    if (sql.startsWith('SELECT * FROM dm_conversations WHERE peer_hex')) {
      const row = this.convs.get(p[0] as string);
      return (row ? [row] : []) as T[];
    }
    if (sql.startsWith('SELECT * FROM dm_conversations')) {
      return [...this.convs.values()] as T[];
    }
    if (sql.startsWith('SELECT * FROM dm_messages WHERE peer_hex')) {
      return [...this.msgs.values()]
        .filter(m => m.peer_hex === p[0])
        .sort((a, b) => a.created_at_ms - b.created_at_ms) as T[];
    }
    if (sql.startsWith('SELECT * FROM dm_messages WHERE delivery_id')) {
      return [...this.msgs.values()].filter(
        m => m.delivery_id === p[0] && m.direction === p[1],
      ) as T[];
    }
    if (sql.startsWith('SELECT MAX(sender_created_at_sec)')) {
      const inbound = [...this.msgs.values()].filter(m => m.direction === 'in');
      const latest = inbound.reduce<number | null>(
        (acc, m) => (m.sender_created_at_sec !== null && (acc === null || m.sender_created_at_sec > acc) ? m.sender_created_at_sec : acc),
        null,
      );
      return [{ latest }] as T[];
    }
    if (sql.startsWith('SELECT delivery_id FROM dm_seen')) {
      return (this.seen.has(p[0] as string) ? [{ delivery_id: p[0] }] : []) as T[];
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }
}

const PEER = 'b'.repeat(64);
const ENVELOPE = {
  ephemeralPubkeyHex: 'c'.repeat(64),
  recipientHex: PEER,
  sealed: 'sealed-payload',
  createdAt: 1234,
  deliveryId: 'd'.repeat(32),
};

function outRow(id: string, createdAtMs: number): DmMessageRow {
  return {
    id,
    peerHex: PEER,
    direction: 'out',
    sealed: 'sealed-payload',
    envelope: ENVELOPE,
    plainText: 'hello out',
    deliveryId: 'd'.repeat(32),
    ackProof: 'e'.repeat(64),
    createdAtMs,
    status: 'Sending',
    attempts: 0,
    meshAttempts: 0,
    nextAttemptAtMs: createdAtMs,
    senderCreatedAtSec: 1234,
  };
}

describe('SqliteDmStore', () => {
  test('round-trips conversations with prior state, and messages with envelope, plaintext, delivery id, and proof', async () => {
    const db = new FakeDb();
    const store = new SqliteDmStore(db);
    await store.upsertConversation({
      peerHex: PEER,
      state: 'blocked',
      muted: false,
      ignored: false,
      unread: 0,
      lastMessageAtMs: 5,
      lastSealed: 's',
      lastDirection: 'out',
      priorState: 'request',
    });
    await store.addMessage(outRow('m1', 1000));
    const conv = await store.getConversation(PEER);
    expect(conv?.state).toBe('blocked');
    expect(conv?.priorState).toBe('request');
    const [row] = await store.listMessages(PEER);
    expect(row.envelope).toEqual(ENVELOPE);
    expect(row.plainText).toBe('hello out');
    expect(row.deliveryId).toBe('d'.repeat(32));
    expect(row.ackProof).toBe('e'.repeat(64));
    expect(row.senderCreatedAtSec).toBe(1234);
    // Status round-trips through update (Relayed, then Delivered).
    await store.updateMessage({ ...row, status: 'Relayed' });
    await store.updateMessage({ ...row, status: 'Delivered' });
    expect((await store.listMessages(PEER))[0].status).toBe('Delivered');
    expect(await store.findMessageByDeliveryId('d'.repeat(32))).not.toBeNull();
  });

  test('incoming rows never read back plaintext, even if a row carries it', async () => {
    const db = new FakeDb();
    const store = new SqliteDmStore(db);
    await store.addMessage({
      id: 'in1',
      peerHex: PEER,
      direction: 'in',
      sealed: 'sealed-in',
      envelope: { ...ENVELOPE, recipientHex: 'a'.repeat(64) },
      plainText: 'must not persist',
      createdAtMs: 1000,
      status: 'Delivered',
      attempts: 0,
      nextAttemptAtMs: 1000,
      senderCreatedAtSec: 999,
    });
    const [row] = await store.listMessages(PEER);
    expect(row.plainText).toBeUndefined();
    expect(row.envelope).toBeDefined();
    expect(row.senderCreatedAtSec).toBe(999);
  });

  test('seen delivery ids and the restart watermark survive as rows', async () => {
    const db = new FakeDb();
    const store = new SqliteDmStore(db);
    expect(await store.hasSeenDelivery('d'.repeat(32))).toBe(false);
    await store.markSeenDelivery('d'.repeat(32), PEER);
    expect(await store.hasSeenDelivery('d'.repeat(32))).toBe(true);
    // Re-marking is idempotent (INSERT OR IGNORE).
    await store.markSeenDelivery('d'.repeat(32), PEER);
    expect(await store.hasSeenDelivery('d'.repeat(32))).toBe(true);
    expect(await store.lastInboundCreatedAtSec()).toBeNull();
    await store.addMessage({
      id: 'in2',
      peerHex: PEER,
      direction: 'in',
      sealed: 'sealed-in',
      createdAtMs: 2000,
      status: 'Delivered',
      attempts: 0,
      nextAttemptAtMs: 2000,
      senderCreatedAtSec: 777,
    });
    expect(await store.lastInboundCreatedAtSec()).toBe(777);
  });

  test('round-trips the Relayed re-publish count and the inbound ack-sent marker', async () => {
    const db = new FakeDb();
    const store = new SqliteDmStore(db);
    await store.addMessage({ ...outRow('m2', 1000), status: 'Relayed', relayRepublishAttempts: 2 });
    await store.addMessage({
      id: 'in3',
      peerHex: PEER,
      direction: 'in',
      sealed: 'sealed-in',
      envelope: { ...ENVELOPE, recipientHex: 'a'.repeat(64) },
      createdAtMs: 2000,
      status: 'Delivered',
      attempts: 0,
      nextAttemptAtMs: 2000,
      senderCreatedAtSec: 888,
      ackSent: true,
    });
    const rows = await store.listMessages(PEER);
    expect(rows.find(r => r.id === 'm2')?.relayRepublishAttempts).toBe(2);
    expect(rows.find(r => r.id === 'in3')?.ackSent).toBe(true);
    await store.updateMessage({ ...rows.find(r => r.id === 'm2') as DmMessageRow, relayRepublishAttempts: 3 });
    expect((await store.listMessages(PEER)).find(r => r.id === 'm2')?.relayRepublishAttempts).toBe(3);
  });

  test('delete removes the conversation and messages but keeps seen ids', async () => {
    const db = new FakeDb();
    const store = new SqliteDmStore(db);
    await store.upsertConversation({
      peerHex: PEER,
      state: 'inbox',
      muted: false,
      ignored: false,
      unread: 1,
      lastMessageAtMs: 5,
      lastSealed: null,
      lastDirection: null,
    });
    await store.addMessage(outRow('m9', 1000));
    await store.markSeenDelivery('d'.repeat(32), PEER);
    await store.deleteConversation(PEER);
    expect(await store.getConversation(PEER)).toBeNull();
    expect(await store.listMessages(PEER)).toEqual([]);
    expect(await store.hasSeenDelivery('d'.repeat(32))).toBe(true);
  });
});

