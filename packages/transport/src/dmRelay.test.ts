// SPDX-License-Identifier: Apache-2.0
// R5 DM relay tests: pooled sockets reused across sends, parallel publish
// with a short first-OK deadline, a live subscription held across drops
// with since backfill, and EOSE never gating delivery.

import { WsDmRelay, dmEnvelopeToNostrEvent } from './dmRelay';
import { sealDm, type DmEnvelope } from './dm';

const tick = (ms = 10) => new Promise<void>(r => setTimeout(r, ms));

/** Fake socket with manual open/close control and inbound injection. */
class FakeSocket {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;

  open(): void {
    this.onopen?.({});
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  fail(): void {
    this.onerror?.({});
  }
  inject(msg: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  eventsSent(): unknown[][] {
    return this.sent.map(s => JSON.parse(s) as unknown[]);
  }
}

function makeRelay(opts?: { publishTimeoutMs?: number; reconnectMs?: number }) {
  const sockets = new Map<string, FakeSocket[]>();
  const relay = new WsDmRelay({
    relays: ['wss://fast.relay', 'wss://slow.relay'],
    wsFactory: url => {
      const s = new FakeSocket();
      const list = sockets.get(url) ?? [];
      list.push(s);
      sockets.set(url, list);
      return s;
    },
    publishTimeoutMs: opts?.publishTimeoutMs ?? 200,
    reconnectMs: opts?.reconnectMs ?? 10,
    reconnectMaxMs: 50,
  });
  const socketFor = (url: string, index = 0) => sockets.get(url)?.[index];
  const openAll = () => {
    for (const list of sockets.values()) for (const s of list) s.open();
  };
  return { relay, sockets, socketFor, openAll };
}

const envelope = (): DmEnvelope => sealDm('hello r5', 'a'.repeat(64), 'b'.repeat(64), 1700000000);

describe('WsDmRelay pooled fast path', () => {
  test('parallel publish: first OK wins, slow relay never delays it', async () => {
    const { relay, socketFor, openAll } = makeRelay();
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    expect(socketFor('wss://fast.relay')?.eventsSent().filter(m => m[0] === 'EVENT')).toHaveLength(1);
    expect(socketFor('wss://slow.relay')?.eventsSent().filter(m => m[0] === 'EVENT')).toHaveLength(1);
    const eventId = (socketFor('wss://fast.relay')?.eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    socketFor('wss://fast.relay')?.inject(['OK', eventId, true, '']);
    await expect(pending).resolves.toBe(true);
    expect(relay.relayHealth().find(h => h.url === 'wss://fast.relay')?.ok).toBe(1);
  });

  test('pooled sockets are reused across sends (no fresh socket per DM)', async () => {
    const { relay, sockets, openAll } = makeRelay();
    const first = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    const eventId = (sockets.get('wss://fast.relay')?.[0].eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    sockets.get('wss://fast.relay')?.[0].inject(['OK', eventId, true, '']);
    await expect(first).resolves.toBe(true);
    const second = relay.publish(envelope());
    await tick();
    expect(sockets.get('wss://fast.relay')).toHaveLength(1);
    expect(sockets.get('wss://slow.relay')).toHaveLength(1);
    expect(sockets.get('wss://fast.relay')?.[0].eventsSent().filter(m => m[0] === 'EVENT')).toHaveLength(2);
    await tick(250);
    await expect(second).resolves.toBe(false);
  });

  test('deadline expiry resolves false when no relay answers', async () => {
    const { relay, openAll } = makeRelay({ publishTimeoutMs: 50 });
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await expect(pending).resolves.toBe(false);
  });

  test('all relays rejecting resolves false without waiting for the deadline', async () => {
    const { relay, socketFor, openAll } = makeRelay({ publishTimeoutMs: 5000 });
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    const slow = socketFor('wss://slow.relay');
    const eventId = (fast?.eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    fast?.inject(['OK', eventId, false, 'rejected']);
    slow?.inject(['OK', eventId, false, 'rejected']);
    await expect(pending).resolves.toBe(false);
  });

  test('EVENT before EOSE is delivered at once; EOSE never gates it', async () => {
    const { relay, socketFor, openAll } = makeRelay();
    const seen: DmEnvelope[] = [];
    const ownHex = 'b'.repeat(64);
    relay.subscribe(ownHex, e => seen.push(e));
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    expect(fast?.eventsSent().filter(m => m[0] === 'REQ')).toHaveLength(1);
    const event = dmEnvelopeToNostrEvent(sealDm('before eose', 'a'.repeat(64), ownHex, 1700000100));
    fast?.inject(['EVENT', 'dm-bbbbbbbb', event]);
    expect(seen).toHaveLength(1);
    expect(seen[0].sealed).toBeDefined();
    fast?.inject(['EOSE', 'dm-bbbbbbbb']);
    expect(seen).toHaveLength(1);
  });

  test('dropped subscription socket reconnects and backfills with since', async () => {
    const { relay, sockets, socketFor, openAll } = makeRelay({ reconnectMs: 10 });
    const seen: DmEnvelope[] = [];
    const ownHex = 'b'.repeat(64);
    const unsub = relay.subscribe(ownHex, e => seen.push(e));
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    const event = dmEnvelopeToNostrEvent(sealDm('first', 'a'.repeat(64), ownHex, 1700000200));
    fast?.inject(['EVENT', 'dm-bbbbbbbb', event]);
    expect(seen).toHaveLength(1);
    fast?.close();
    await tick(100);
    const reconnected = sockets.get('wss://fast.relay')?.[1];
    expect(reconnected).toBeDefined();
    reconnected?.open();
    await tick();
    const reqs = reconnected?.eventsSent().filter(m => m[0] === 'REQ') ?? [];
    expect(reqs).toHaveLength(1);
    expect((reqs[0][2] as Record<string, unknown>).since).toBe(1700000200);
    unsub();
  });
});
