// SPDX-License-Identifier: Apache-2.0
// WsDmRelay tests: subscription reconnect, publish socket close/error paths,
// custom relay lists, bounded subscribe filters, plus the R5 pooled fast
// path (parallel publish, pooled sockets, live resubscribe/backfill).
// Relays are fully mocked; no network touches this file.

import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { dmToHex, sealDm, type DmEnvelope } from './dm';
import {
  WsDmRelay,
  dmEnvelopeToNostrEvent,
  nostrEventToDmEnvelope,
} from './dmRelay';
import type { WebSocketLike } from './nostr';

/** In-memory fake WebSocket: records sends, lets tests inject events. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.closed) throw new Error('send on closed socket');
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose({});
  }

  open(): void {
    if (this.onopen) this.onopen({});
  }

  receive(msg: unknown[]): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }

  eventsSent(): unknown[][] {
    return this.sent.map(s => JSON.parse(s) as unknown[]);
  }

  fail(): void {
    if (this.onerror) this.onerror({});
  }
}

function makeRelay(sockets: FakeSocket[], opts: { publishTimeoutMs?: number } = {}): WsDmRelay {
  return new WsDmRelay({
    relays: ['wss://test.relay'],
    wsFactory: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    publishTimeoutMs: opts.publishTimeoutMs ?? 1000,
  });
}

describe('WsDmRelay', () => {
  test('subscribe uses the configured relay list, not package defaults', () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://custom.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const unsub = relay.subscribe('aa'.repeat(32), () => {});
    expect(sockets.map((s) => s.url)).toEqual(['wss://custom.relay']);
    unsub();
  });

  test('subscribe filter is bounded by since, not full relay history', () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://custom.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const before = Math.floor(Date.now() / 1000);
    const unsub = relay.subscribe('bb'.repeat(32), () => {});
    sockets[0].open();
    const req = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(req).toBeDefined();
    expect(req[2]['#p']).toEqual(['bb'.repeat(32)]);
    expect(req[2].since as number).toBeGreaterThanOrEqual(before - 86400 - 5);
    expect(req[2].since as number).toBeLessThanOrEqual(before);
    unsub();
  });
});

describe('WsDmRelay.subscribe reconnect (P1-10)', () => {
  test('a dropped subscription reopens and re-sends the same REQ', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const relay = makeRelay(sockets);
      const ownHex = 'a'.repeat(64);
      const received: DmEnvelope[] = [];
      const unsub = relay.subscribe(ownHex, e => {
        received.push(e);
      });
      expect(sockets).toHaveLength(1);
      sockets[0].open();
      const req = JSON.parse(sockets[0].sent[0]) as unknown[];
      expect(req[0]).toBe('REQ');
      expect(req[1]).toBe(`dm-${ownHex.slice(0, 8)}`);
      // Drop the socket; the replacement must re-send the same REQ.
      sockets[0].close();
      expect(sockets).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      const req2 = JSON.parse(sockets[1].sent[0]) as unknown[];
      expect(req2).toEqual(req);
      // The replacement subscription still delivers.
      const sender = ed25519.utils.randomSecretKey();
      const envelope = sealDm('hello again', dmToHex(ed25519.getPublicKey(sender)), ownHex);
      const event = dmEnvelopeToNostrEvent(envelope);
      sockets[1].receive(['EVENT', req2[1], event]);
      expect(received).toHaveLength(1);
      expect(received[0].sealed).toBe(envelope.sealed);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  test('unsubscribe stops retries: a later drop opens nothing', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const relay = makeRelay(sockets);
      const unsub = relay.subscribe('b'.repeat(64), () => {});
      sockets[0].open();
      unsub();
      expect(sockets[0].closed).toBe(true);
      const count = sockets.length;
      // A close arriving after unsubscribe must not schedule a reconnect.
      if (sockets[0].onclose) sockets[0].onclose({});
      await jest.advanceTimersByTimeAsync(5000);
      expect(sockets).toHaveLength(count);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('WsDmRelay.publish socket paths (P1-11)', () => {
  test('a close without OK resolves false immediately, not at the timeout', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets, { publishTimeoutMs: 60000 });
    const envelope = sealDm('close me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    sockets[0].close();
    await expect(result).resolves.toBe(false);
  });

  test('an error resolves false and closes the socket (no leak)', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('error me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    sockets[0].fail();
    await expect(result).resolves.toBe(false);
    expect(sockets[0].closed).toBe(true);
  });

  test('a send throw resolves false and closes the socket', async () => {
    class ThrowingSocket extends FakeSocket {
      override send(): void {
        throw new Error('send boom');
      }
    }
    const sockets: ThrowingSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://test.relay'],
      wsFactory: (url: string) => {
        const s = new ThrowingSocket(url);
        sockets.push(s);
        return s;
      },
      publishTimeoutMs: 1000,
    });
    const envelope = sealDm('throw me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    await expect(result).resolves.toBe(false);
    expect(sockets[0].closed).toBe(true);
  });

  test('first-OK-wins: an OK still resolves true, and the pooled socket stays open for reuse', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('ok me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    // Pooled publish sends on a microtask after open (waitOpen), so wait
    // a tick before reading the sent frame.
    await new Promise(r => setTimeout(r, 0));
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string };
    sockets[0].receive(['OK', event.id, true]);
    await expect(result).resolves.toBe(true);
    // R5 pooled sockets are held across sends, not closed per publish.
    expect(sockets[0].closed).toBe(false);
  });
});

describe('WsDmRelay.publish event reuse on retry (F14-retry)', () => {
  test('publishing the same envelope twice sends the same event id', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('retry me', 'd'.repeat(64), 'e'.repeat(64));
    const first = relay.publish(envelope);
    sockets[0].open();
    await new Promise(r => setTimeout(r, 0));
    const firstEvent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const firstId = (firstEvent[1] as { id: string }).id;
    sockets[0].receive(['OK', firstId, true]);
    await expect(first).resolves.toBe(true);
    // R5 pooled path: the second publish reuses the SAME socket, and the
    // cached event keeps the same id.
    const second = relay.publish(envelope);
    await new Promise(r => setTimeout(r, 0));
    expect(sockets).toHaveLength(1);
    const secondEvent = JSON.parse(sockets[0].sent[1]) as unknown[];
    expect((secondEvent[1] as { id: string }).id).toBe(firstId);
    sockets[0].receive(['OK', firstId, true]);
    await expect(second).resolves.toBe(true);
  });
});

describe('nostrEventToDmEnvelope relay verification (F12)', () => {
  test('a forged signature, a wrong id, and a mismatched p tag are all rejected', () => {
    const sender = ed25519.utils.randomSecretKey();
    const envelope = sealDm('real', dmToHex(ed25519.getPublicKey(sender)), 'c'.repeat(64));
    const event = dmEnvelopeToNostrEvent(envelope);
    expect(nostrEventToDmEnvelope(event)).not.toBeNull();
    const badSig = { ...event, sig: event.sig.slice(0, -1) + (event.sig.endsWith('0') ? '1' : '0') };
    expect(nostrEventToDmEnvelope(badSig)).toBeNull();
    expect(nostrEventToDmEnvelope({ ...event, id: '0'.repeat(64) })).toBeNull();
    // Valid signature over mismatched tags: the p tag must match the
    // envelope recipient even when the signature itself verifies.
    const keys = schnorr.utils.randomPrivateKey();
    const pubkey = dmToHex(schnorr.getPublicKey(keys));
    const tags = [['p', 'f'.repeat(64)]];
    const content = JSON.stringify(envelope);
    const idBytes = sha256(
      new TextEncoder().encode(JSON.stringify([0, pubkey, envelope.createdAt, 1059, tags, content])),
    );
    const mismatched = {
      id: dmToHex(idBytes),
      pubkey,
      created_at: envelope.createdAt,
      kind: 1059,
      tags,
      content,
      sig: dmToHex(schnorr.sign(idBytes, keys)),
    };
    expect(nostrEventToDmEnvelope(mismatched)).toBeNull();
  });

  test('events for another subscription id are ignored by subscribe', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const ownHex = 'c'.repeat(64);
    const received: DmEnvelope[] = [];
    const unsub = relay.subscribe(ownHex, e => {
      received.push(e);
    });
    sockets[0].open();
    const req = JSON.parse(sockets[0].sent[0]) as unknown[];
    const sender = ed25519.utils.randomSecretKey();
    const envelope = sealDm('for me', dmToHex(ed25519.getPublicKey(sender)), ownHex);
    const event = dmEnvelopeToNostrEvent(envelope);
    sockets[0].receive(['EVENT', 'some-other-sub', event]);
    expect(received).toHaveLength(0);
    sockets[0].receive(['EVENT', req[1], event]);
    expect(received).toHaveLength(1);
    unsub();
  });
});

describe('nostrEventToDmEnvelope event id carry (P1-06)', () => {
  test('the parsed envelope carries the relay event id for dedup', () => {
    const sender = ed25519.utils.randomSecretKey();
    const envelope = sealDm('carried', dmToHex(ed25519.getPublicKey(sender)), 'c'.repeat(64));
    const event = dmEnvelopeToNostrEvent(envelope);
    const parsed = nostrEventToDmEnvelope(event);
    expect(parsed?.relayEventId).toBe(event.id);
  });
});

const tick = (ms = 10) => new Promise<void>(r => setTimeout(r, ms));

function makePooledRelay(opts?: { publishTimeoutMs?: number; reconnectMs?: number }) {
  const sockets = new Map<string, FakeSocket[]>();
  const relay = new WsDmRelay({
    relays: ['wss://fast.relay', 'wss://slow.relay'],
    wsFactory: url => {
      const s = new FakeSocket(url);
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
    const { relay, socketFor, openAll } = makePooledRelay();
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    expect(socketFor('wss://fast.relay')?.eventsSent().filter(m => m[0] === 'EVENT')).toHaveLength(1);
    expect(socketFor('wss://slow.relay')?.eventsSent().filter(m => m[0] === 'EVENT')).toHaveLength(1);
    const eventId = (socketFor('wss://fast.relay')?.eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    socketFor('wss://fast.relay')?.receive(['OK', eventId, true, '']);
    await expect(pending).resolves.toBe(true);
    expect(relay.relayHealth().find(h => h.url === 'wss://fast.relay')?.ok).toBe(1);
  });

  test('pooled sockets are reused across sends (no fresh socket per DM)', async () => {
    const { relay, sockets, openAll } = makePooledRelay();
    const first = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    const eventId = (sockets.get('wss://fast.relay')?.[0].eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    sockets.get('wss://fast.relay')?.[0].receive(['OK', eventId, true, '']);
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
    const { relay, openAll } = makePooledRelay({ publishTimeoutMs: 50 });
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await expect(pending).resolves.toBe(false);
  });

  test('all relays rejecting resolves false without waiting for the deadline', async () => {
    const { relay, socketFor, openAll } = makePooledRelay({ publishTimeoutMs: 5000 });
    const pending = relay.publish(envelope());
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    const slow = socketFor('wss://slow.relay');
    const eventId = (fast?.eventsSent().find(m => m[0] === 'EVENT')?.[1] as { id: string }).id;
    fast?.receive(['OK', eventId, false, 'rejected']);
    slow?.receive(['OK', eventId, false, 'rejected']);
    await expect(pending).resolves.toBe(false);
  });

  test('EVENT before EOSE is delivered at once; EOSE never gates it', async () => {
    const { relay, socketFor, openAll } = makePooledRelay();
    const seen: DmEnvelope[] = [];
    const ownHex = 'b'.repeat(64);
    relay.subscribe(ownHex, e => seen.push(e));
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    expect(fast?.eventsSent().filter(m => m[0] === 'REQ')).toHaveLength(1);
    const event = dmEnvelopeToNostrEvent(sealDm('before eose', 'a'.repeat(64), ownHex, 1700000100));
    fast?.receive(['EVENT', 'dm-bbbbbbbb', event]);
    expect(seen).toHaveLength(1);
    expect(seen[0].sealed).toBeDefined();
    fast?.receive(['EOSE', 'dm-bbbbbbbb']);
    expect(seen).toHaveLength(1);
  });

  test('dropped subscription socket reconnects and backfills with since', async () => {
    const { relay, sockets, socketFor, openAll } = makePooledRelay({ reconnectMs: 10 });
    const seen: DmEnvelope[] = [];
    const ownHex = 'b'.repeat(64);
    const unsub = relay.subscribe(ownHex, e => seen.push(e));
    await tick();
    openAll();
    await tick();
    const fast = socketFor('wss://fast.relay');
    const event = dmEnvelopeToNostrEvent(sealDm('first', 'a'.repeat(64), ownHex, 1700000200));
    fast?.receive(['EVENT', 'dm-bbbbbbbb', event]);
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
