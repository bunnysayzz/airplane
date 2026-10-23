// SPDX-License-Identifier: Apache-2.0
// NostrTransport + wrap/unwrap codec tests. Relays are fully mocked - no
// network touches this file.

import {
  encodeEvent,
  fromHex,
  toHex,
  type SignedEvent,
} from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
import {
  AIRPLANE_NOSTR_KIND,
  DEFAULT_RELAYS,
  NostrTransport,
  generateNostrKeypair,
  nostrEventId,
  unwrapEvent,
  wrapEvent,
  type NostrEvent,
  type WebSocketLike,
} from './nostr';

/** In-memory fake WebSocket: records sends, lets tests inject messages. */
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
    this.closed = true;
    if (this.onclose) this.onclose({});
  }

  /** Simulate the relay accepting the connection. */
  open(): void {
    if (this.onopen) this.onopen({});
  }

  /** Simulate an inbound relay message. */
  receive(msg: unknown[]): void {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

function makeTransport(urls: string[] = ['wss://test.relay']) {
  const sockets: FakeSocket[] = [];
  const t = new NostrTransport({
    relays: urls,
    reconnectMs: 10,
    wsFactory: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      // Open asynchronously like a real socket.
      setTimeout(() => s.open(), 0);
      return s;
    },
  });
  return { t, sockets };
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

describe('wrapEvent / unwrapEvent', () => {
  test('round-trips a signed event with inner signature intact', () => {
    const keys = generateNostrKeypair();
    const event = makePost('hello nostr');
    const wrapped = wrapEvent(event, keys, 1_700_000_001);

    expect(wrapped.kind).toBe(AIRPLANE_NOSTR_KIND);
    expect(wrapped.pubkey).toBe(toHex(keys.publicKey));
    expect(wrapped.tags).toContainEqual(['e', toHex(event.id)]);
    expect(wrapped.tags).toContainEqual(['g', event.geohash]);
    expect(wrapped.tags).toContainEqual(['airplane', '1']);

    // Nostr id/sig are self-consistent (would pass relay validation).
    const recomputed = nostrEventId(
      wrapped.pubkey,
      wrapped.created_at,
      wrapped.kind,
      wrapped.tags,
      wrapped.content,
    );
    expect(toHex(recomputed)).toBe(wrapped.id);

    const back = unwrapEvent(wrapped);
    expect(back).not.toBeNull();
    expect(toHex(back!.id)).toBe(toHex(event.id));
    expect(back!.content).toBe('hello nostr');
  });

  test('unwrapEvent rejects wrong kind', () => {
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(makePost(), keys);
    expect(unwrapEvent({ ...wrapped, kind: 1 })).toBeNull();
  });

  test('unwrapEvent rejects missing airplane tag', () => {
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(makePost(), keys);
    const stripped: NostrEvent = {
      ...wrapped,
      tags: wrapped.tags.filter((t) => t[0] !== 'airplane'),
    };
    expect(unwrapEvent(stripped)).toBeNull();
  });

  test('unwrapEvent rejects tampered inner content', () => {
    const keys = generateNostrKeypair();
    const event = makePost('original');
    const wrapped = wrapEvent(event, keys);
    // Flip a hex char in the CBOR payload -> inner sig no longer verifies.
    const tampered: NostrEvent = {
      ...wrapped,
      content: 'ff' + wrapped.content.slice(2),
    };
    expect(unwrapEvent(tampered)).toBeNull();
  });

  test('unwrapEvent rejects garbage content', () => {
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(makePost(), keys);
    expect(unwrapEvent({ ...wrapped, content: 'zzzz' })).toBeNull();
  });
});

describe('NostrTransport', () => {
  test('connects to all relays on start; online when one opens', async () => {
    const { t, sockets } = makeTransport(['wss://a.relay', 'wss://b.relay']);
    expect(t.online).toBe(false);
    await t.start();
    await tick(20);
    expect(sockets).toHaveLength(2);
    expect(t.getRelayState('wss://a.relay')).toBe('open');
    expect(t.online).toBe(true);
    await t.stop();
    expect(t.online).toBe(false);
  });

  test('publish sends EVENT to open relays and returns their urls', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const event = makePost('publish me');
    const urls = await t.publish(event);
    expect(urls).toEqual(['wss://test.relay']);
    const sent = JSON.parse(sockets[0].sent.find((s) => s.includes('"EVENT"'))!);
    expect(sent[0]).toBe('EVENT');
    expect(sent[1].kind).toBe(AIRPLANE_NOSTR_KIND);
    await t.stop();
  });

  test('publish to closed relay returns empty (no throw)', async () => {
    const { t } = makeTransport();
    // Never started: no open relays.
    const urls = await t.publish(makePost());
    expect(urls).toEqual([]);
  });

  test('inbound EVENT is unwrapped, verified, and emitted', async () => {
    const { t, sockets } = makeTransport();
    const keys = generateNostrKeypair();
    await t.start();
    await tick(20);

    const received: SignedEvent[] = [];
    t.onReceive((e) => {
      received.push(e);
    });

    const event = makePost('from relay');
    const wrapped = wrapEvent(event, keys);
    sockets[0].receive(['EVENT', 'sub1', wrapped]);
    await tick(10);

    expect(received).toHaveLength(1);
    expect(toHex(received[0].id)).toBe(toHex(event.id));
    await t.stop();
  });

  test('inbound EVENT with bad inner sig is dropped', async () => {
    const { t, sockets } = makeTransport();
    const keys = generateNostrKeypair();
    await t.start();
    await tick(20);

    const received: SignedEvent[] = [];
    t.onReceive((e) => {
      received.push(e);
    });

    const wrapped = wrapEvent(makePost('x'), keys);
    wrapped.content = '00' + wrapped.content.slice(2); // tamper
    sockets[0].receive(['EVENT', 'sub1', wrapped]);
    await tick(10);

    expect(received).toHaveLength(0);
    await t.stop();
  });

  test('queryByIds sends REQ with #e filter', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    await t.queryByIds(['aa'.repeat(32), 'bb'.repeat(32)]);
    const req = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((m) => m[0] === 'REQ' && m[2] && '#e' in m[2]);
    expect(req).toBeDefined();
    expect(req[2]['#e']).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    await t.stop();
  });

  test('default relays are the curated list', () => {
    const t = new NostrTransport({ wsFactory: () => { throw new Error('nope'); } });
    expect(t.relayUrls).toEqual(DEFAULT_RELAYS);
    expect(DEFAULT_RELAYS.length).toBeGreaterThan(0);
    expect(DEFAULT_RELAYS.every((u) => u.startsWith('wss://'))).toBe(true);
  });

  test('encodeEvent bytes survive wrap (sanity: content decodes)', () => {
    const event = makePost('bytes check');
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(event, keys);
    // Content must be the exact CBOR encoding, hex-encoded.
    const raw = fromHex(wrapped.content);
    expect(Array.from(raw)).toEqual(Array.from(encodeEvent(event)));
  });
});

describe('NostrTransport reconnect backoff', () => {
  /** Socket that never opens on its own; tests drive close() manually. */
  class ManualSocket implements WebSocketLike {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    sent: string[] = [];
    constructor(readonly url: string) {}
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      if (this.onclose) this.onclose({});
    }
    open(): void {
      if (this.onopen) this.onopen({});
    }
  }

  test('retries use bounded exponential backoff with a cap', () => {
    jest.useFakeTimers();
    try {
      const sockets: ManualSocket[] = [];
      const connectTimes: number[] = [];
      const t = new NostrTransport({
        relays: ['wss://backoff.relay'],
        reconnectMs: 100,
        reconnectMaxMs: 300,
        wsFactory: (url: string) => {
          const s = new ManualSocket(url);
          sockets.push(s);
          connectTimes.push(Date.now());
          return s;
        },
      });
      void t.start();
      expect(sockets).toHaveLength(1);

      // Drop the connection repeatedly without ever opening: each close
      // schedules a reconnect with a growing delay. Step the clock forward
      // in small increments to measure each close->reconnect gap exactly.
      const gaps: number[] = [];
      for (let i = 0; i < 4; i++) {
        sockets[i].close();
        const closedAt = Date.now();
        let guard = 0;
        while (sockets.length === i + 1 && guard++ < 1000) {
          jest.advanceTimersByTime(10);
        }
        expect(sockets).toHaveLength(i + 2);
        gaps.push(Date.now() - closedAt);
      }

      // base 100: [80,120] -> [160,240] -> capped [240,360] -> capped [240,360]
      expect(gaps[0]).toBeGreaterThanOrEqual(80);
      expect(gaps[0]).toBeLessThanOrEqual(120);
      expect(gaps[1]).toBeGreaterThanOrEqual(160);
      expect(gaps[1]).toBeLessThanOrEqual(240);
      // Without the 300ms cap, attempt 2 would be [320,480].
      expect(gaps[2]).toBeGreaterThanOrEqual(240);
      expect(gaps[2]).toBeLessThanOrEqual(360);
      expect(gaps[3]).toBeGreaterThanOrEqual(240);
      expect(gaps[3]).toBeLessThanOrEqual(360);

      void t.stop();
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a successful open resets the backoff to the base delay', () => {
    jest.useFakeTimers();
    try {
      const sockets: ManualSocket[] = [];
      const connectTimes: number[] = [];
      const t = new NostrTransport({
        relays: ['wss://backoff.relay'],
        reconnectMs: 100,
        reconnectMaxMs: 300,
        wsFactory: (url: string) => {
          const s = new ManualSocket(url);
          sockets.push(s);
          connectTimes.push(Date.now());
          return s;
        },
      });
      void t.start();

      // Two consecutive drops grow the delay; measure close->reconnect.
      const measureGap = (socket: ManualSocket): number => {
        const before = sockets.length;
        socket.close();
        const closedAt = Date.now();
        let guard = 0;
        while (sockets.length === before && guard++ < 1000) {
          jest.advanceTimersByTime(10);
        }
        expect(sockets.length).toBeGreaterThan(before);
        return Date.now() - closedAt;
      };
      const grownGap = measureGap(sockets[0]);
      expect(grownGap).toBeGreaterThanOrEqual(80);

      // ...but a successful connection resets the failure count.
      sockets[1].open();
      const resetGap = measureGap(sockets[1]);
      expect(resetGap).toBeGreaterThanOrEqual(80);
      expect(resetGap).toBeLessThanOrEqual(120);

      void t.stop();
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  test('stop() cancels pending reconnects', () => {
    jest.useFakeTimers();
    try {
      const sockets: ManualSocket[] = [];
      const t = new NostrTransport({
        relays: ['wss://backoff.relay'],
        reconnectMs: 100,
        wsFactory: (url: string) => {
          const s = new ManualSocket(url);
          sockets.push(s);
          return s;
        },
      });
      void t.start();
      sockets[0].close(); // schedules a reconnect
      void t.stop();
      jest.advanceTimersByTime(60_000);
      // No new socket: the pending reconnect was cancelled.
      expect(sockets).toHaveLength(1);
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });
});
