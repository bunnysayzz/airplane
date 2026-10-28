// SPDX-License-Identifier: Apache-2.0
// SQLite DM store tests against node:sqlite (real SQL, no mocks of the
// store logic): round-trip of conversations + messages, envelope JSON
// persistence, delete-local-only, and a reopened-database survival check
// (the R5 restart criterion at the store level).

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabasePort } from '@airplane/storage';
import { sealDm, type DmConversationRow, type DmMessageRow } from '@airplane/transport';
import { SqliteDmStore } from './dmSqlite';

type BindParam = string | number | bigint | Uint8Array | null;

function makePort(db: DatabaseSync): DatabasePort {
  return {
    exec: async (sql: string, params: unknown[] = []): Promise<void> => {
      db.prepare(sql).run(...(params as BindParam[]));
    },
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      db.prepare(sql).all(...(params as BindParam[])) as T[],
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-dm-sqlite-'));
  tempDirs.push(dir);
  return path.join(dir, 'dm.db');
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function conversation(peerHex: string, overrides: Partial<DmConversationRow> = {}): DmConversationRow {
  return {
    peerHex,
    state: 'inbox',
    muted: false,
    ignored: false,
    unread: 2,
    lastMessageAtMs: 1700000000000,
    lastSealed: 'sealed-preview',
    lastDirection: 'in',
    ...overrides,
  };
}

function message(id: string, peerHex: string, overrides: Partial<DmMessageRow> = {}): DmMessageRow {
  const envelope = sealDm('dm text', 'a'.repeat(64), peerHex, 1700000000);
  return {
    id,
    peerHex,
    direction: 'out',
    sealed: envelope.sealed,
    envelope,
    createdAtMs: 1700000000000,
    status: 'Sending',
    attempts: 0,
    nextAttemptAtMs: 1700000000000,
    ...overrides,
  };
}

describe('SqliteDmStore', () => {
  test('conversation + message round-trip, envelope JSON preserved', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteDmStore(makePort(db));
    const peer = 'b'.repeat(64);
    await store.upsertConversation(conversation(peer));
    await store.addMessage(message('m1', peer));
    await store.addMessage(message('m2', peer, { direction: 'in', status: 'Sent', createdAtMs: 1700000001000 }));
    const conv = await store.getConversation(peer);
    expect(conv?.unread).toBe(2);
    expect(conv?.lastSealed).toBe('sealed-preview');
    const messages = await store.listMessages(peer);
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe('m1');
    expect(messages[0].envelope?.recipientHex).toBe(peer);
    expect(messages[0].envelope?.sealed).toBe(messages[0].sealed);
    expect(messages[1].direction).toBe('in');
    db.close();
  });

  test('updateMessage persists status/attempts; upsert overwrites the conversation row', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteDmStore(makePort(db));
    const peer = 'c'.repeat(64);
    await store.upsertConversation(conversation(peer));
    const m = message('m1', peer);
    await store.addMessage(m);
    await store.updateMessage({ ...m, status: 'Sent', attempts: 2 });
    const messages = await store.listMessages(peer);
    expect(messages[0].status).toBe('Sent');
    expect(messages[0].attempts).toBe(2);
    await store.upsertConversation(conversation(peer, { unread: 0, muted: true }));
    const conv = await store.getConversation(peer);
    expect(conv?.unread).toBe(0);
    expect(conv?.muted).toBe(true);
    expect((await store.listConversations()).map(c => c.peerHex)).toEqual([peer]);
    db.close();
  });

  test('deleteConversation removes the conversation and its messages only', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteDmStore(makePort(db));
    const peerA = 'd'.repeat(64);
    const peerB = 'e'.repeat(64);
    await store.upsertConversation(conversation(peerA));
    await store.upsertConversation(conversation(peerB));
    await store.addMessage(message('m1', peerA));
    await store.addMessage(message('m2', peerB));
    await store.deleteConversation(peerA);
    expect(await store.getConversation(peerA)).toBeNull();
    expect(await store.listMessages(peerA)).toEqual([]);
    expect(await store.getConversation(peerB)).not.toBeNull();
    expect(await store.listMessages(peerB)).toHaveLength(1);
    db.close();
  });

  test('rows survive close + reopen of the database file (restart criterion)', async () => {
    const file = tempDbPath();
    const peer = 'f'.repeat(64);
    {
      const db = new DatabaseSync(file);
      const store = new SqliteDmStore(makePort(db));
      await store.upsertConversation(conversation(peer, { unread: 1 }));
      await store.addMessage(message('m1', peer));
      db.close();
    }
    const db2 = new DatabaseSync(file);
    const reopened = new SqliteDmStore(makePort(db2));
    const messages = await reopened.listMessages(peer);
    expect(messages).toHaveLength(1);
    expect(messages[0].envelope?.recipientHex).toBe(peer);
    expect((await reopened.getConversation(peer))?.unread).toBe(1);
    await reopened.updateMessage({ ...messages[0], status: 'Sent' });
    expect((await reopened.listMessages(peer))[0].status).toBe('Sent');
    db2.close();
  });

  test('corrupt envelope JSON reads back as no envelope, never a crash', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteDmStore(makePort(db));
    const peer = 'a'.repeat(64);
    const m = message('m1', peer);
    await store.addMessage(m);
    db.prepare('UPDATE dm_messages SET envelope_json = ? WHERE id = ?').run('not json{', 'm1');
    const messages = await store.listMessages(peer);
    expect(messages).toHaveLength(1);
    expect(messages[0].envelope).toBeUndefined();
    expect(messages[0].sealed).toBe(m.sealed);
    db.close();
  });
});
