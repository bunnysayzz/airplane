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

  test('oversize hex content is rejected before decode', () => {
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(makePost(), keys);
    expect(unwrapEvent({ ...wrapped, content: 'ab'.repeat(5000) })).toBeNull();
  });

  test('unwrapEvent ignores malformed frames without throwing', () => {
    const keys = generateNostrKeypair();
    const wrapped = wrapEvent(makePost(), keys);
    expect(unwrapEvent({ ...wrapped, tags: null as never })).toBeNull();
    expect(unwrapEvent({ ...wrapped, tags: 'airplane' as never })).toBeNull();
    expect(unwrapEvent({ ...wrapped, tags: [null as never] })).toBeNull();
    expect(unwrapEvent({ ...wrapped, content: 42 as never })).toBeNull();
    expect(unwrapEvent({ ...wrapped, content: null as never })).toBeNull();
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

describe('NostrTransport reconnect', () => {
  test('unexpected close schedules a reconnect after reconnectMs', async () => {
    const { t, sockets } = makeTransport(['wss://flaky.relay']);
    await t.start();
    await tick(20);
    expect(t.getRelayState('wss://flaky.relay')).toBe('open');

    // Simulate the relay dropping the connection.
    sockets[0].close();
    expect(t.getRelayState('wss://flaky.relay')).toBe('closed');
    expect(t.online).toBe(false);

    await tick(40); // reconnectMs is 10; the factory auto-opens
    expect(sockets).toHaveLength(2); // a fresh socket was created
    expect(t.getRelayState('wss://flaky.relay')).toBe('open');
    expect(t.online).toBe(true);
    await t.stop();
  });

  test('reconnectNow connects immediately instead of waiting out the backoff ladder', async () => {
    const sockets: FakeSocket[] = [];
    const scheduled: { url: string; delayMs: number; attempt: number }[] = [];
    const t = new NostrTransport({
      relays: ['wss://a.relay', 'wss://b.relay'],
      reconnectMs: 60_000,
      onReconnectScheduled: (url, delayMs, attempt) => scheduled.push({ url, delayMs, attempt }),
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    await tick(20);
    expect(t.openRelayCount()).toBe(2);
    // Both sockets drop: the ladder schedules the next attempt 60 s
    // out (the v0.1.31 lag: validation returned, but the pool only
    // reopened on the ladder's schedule, 17 s later).
    sockets[0].close();
    sockets[1].close();
    expect(t.openRelayCount()).toBe(0);
    await tick(50);
    expect(sockets).toHaveLength(2); // ladder is 60 s out: nothing yet
    // reconnectNow clears the pending timers and connects now.
    t.reconnectNow();
    expect(sockets).toHaveLength(4);
    expect(scheduled.filter((s) => s.delayMs === 0 && s.attempt === 0)).toHaveLength(2);
    await tick(20);
    expect(t.openRelayCount()).toBe(2);
    expect(t.online).toBe(true);
    // A second reconnectNow with the pool open is a no-op.
    t.reconnectNow();
    expect(sockets).toHaveLength(4);
    await t.stop();
  });

  test('wsFactory throw on connect is survived; the reconnect heals', async () => {
    const sockets: FakeSocket[] = [];
    let failFirst = true;
    const t = new NostrTransport({
      relays: ['wss://heal.relay'],
      reconnectMs: 10,
      wsFactory: (url: string) => {
        if (failFirst) {
          failFirst = false;
          throw new Error('dial failed');
        }
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    // First dial threw: still connecting, nothing created yet.
    expect(t.getRelayState('wss://heal.relay')).toBe('connecting');
    expect(sockets).toHaveLength(0);

    await tick(40);
    expect(sockets).toHaveLength(1);
    expect(t.getRelayState('wss://heal.relay')).toBe('open');
    expect(t.online).toBe(true);
    await t.stop();
  });

  test('stop cancels a pending reconnect: no socket is created after stop', async () => {
    const { t, sockets } = makeTransport(['wss://gone.relay']);
    await t.start();
    await tick(20);
    sockets[0].close(); // schedules a reconnect in 10ms
    await t.stop(); // clears the pending timer
    await tick(50);
    expect(sockets).toHaveLength(1); // no reconnect was attempted
    expect(t.online).toBe(false);
  });

  test('start is idempotent: no duplicate sockets or subscriptions', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await t.start();
    await tick(20);
    expect(sockets).toHaveLength(1);
    expect(t.online).toBe(true);
    await t.stop();
  });

  test('a stale onopen after stop does not resurrect the relay as open', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    expect(t.online).toBe(true);
    const sentBefore = sockets[0].sent.length;
    await t.stop();
    sockets[0].open(); // stale open on the discarded socket
    expect(t.getRelayState('wss://test.relay')).toBe('closed');
    expect(t.online).toBe(false);
    expect(sockets[0].sent.length).toBe(sentBefore); // no resubscribe sent
    await t.stop();
  });

  test('a socket error reconnects even when onclose never fires', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    // Break the close-to-onclose link: this socket errors and its close
    // fires nothing, the case the old code stalled on forever.
    sockets[0].close = () => {
      sockets[0].closed = true;
    };
    sockets[0].onerror?.({});
    await tick(40);
    expect(sockets).toHaveLength(2);
    expect(t.getRelayState('wss://test.relay')).toBe('open');
    await t.stop();
  });

  test('a silent socket is force-closed and reconnected', async () => {
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://silent.relay'],
      reconnectMs: 10,
      silenceTimeoutMs: 30,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    await tick(20);
    expect(t.getRelayState('wss://silent.relay')).toBe('open');
    await tick(120); // silence window (30ms) plus reconnect (10ms)
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    await t.stop();
  });

  test('frames keep a socket alive past the silence window', async () => {
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://chatty.relay'],
      reconnectMs: 10,
      silenceTimeoutMs: 30,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    await tick(20);
    // A frame every 20ms, inside the 30ms window, keeps resetting it.
    for (let i = 0; i < 5; i++) {
      sockets[0].receive(['NOTICE', 'still here']);
      await tick(20);
    }
    expect(sockets).toHaveLength(1);
    expect(t.getRelayState('wss://chatty.relay')).toBe('open');
    await t.stop();
  });

  test('an oversize relay frame is dropped before parsing', async () => {
    const { t, sockets } = makeTransport();
    const keys = generateNostrKeypair();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    const wrapped = wrapEvent(makePost('oversize'), keys);
    const frame = JSON.stringify(['EVENT', 'sub1', wrapped]) + ' '.repeat(70000);
    expect(frame.length).toBeGreaterThan(65536);
    sockets[0].onmessage?.({ data: frame });
    await tick(10);
    expect(count).toBe(0);
    await t.stop();
  });

  test('queryByIds closes on EOSE instead of waiting for the timer', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const sent = await t.queryByIds(['aa'.repeat(32)]);
    expect(sent).toBe(true);
    const req = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ' && m[2] && '#e' in m[2]);
    expect(req).toBeDefined();
    sockets[0].receive(['EOSE', req[1]]);
    await tick(10);
    const closes = sockets[0].sent.map((s) => JSON.parse(s)).filter((m) => m[0] === 'CLOSE');
    expect(closes).toEqual([['CLOSE', req[1]]]);
    await t.stop();
  });

  test('queryByIds re-issues a pending query on reconnect', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    await t.queryByIds(['bb'.repeat(32)]);
    const req = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ' && m[2] && '#e' in m[2]);
    expect(req).toBeDefined();
    sockets[0].close(); // reconnect in 10ms, auto-opens
    await tick(50);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const reissued = sockets[1].sent
      .map((s) => JSON.parse(s))
      .find((m) => m[0] === 'REQ' && m[1] === req[1]);
    expect(reissued).toBeDefined();
    expect(reissued[2]['#e']).toEqual(['bb'.repeat(32)]);
    await t.stop();
  });

  test('AUTH, NOTICE and CLOSED frames are surfaced; CLOSED resubscribes', async () => {
    const notices: { frame: string; message: string }[] = [];
    const auths: string[] = [];
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://strict.relay'],
      reconnectMs: 10,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
      onRelayNotice: (_url, frame, message) => {
        notices.push({ frame, message });
      },
      onAuthChallenge: (_url, challenge) => {
        auths.push(challenge);
      },
    });
    await t.start();
    await tick(20);
    const mainReq = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(mainReq).toBeDefined();
    sockets[0].receive(['NOTICE', 'slow down']);
    sockets[0].receive(['AUTH', 'challenge-abc']);
    sockets[0].receive(['CLOSED', mainReq[1], 'auth-required: please auth']);
    await tick(10);
    expect(notices).toEqual([
      { frame: 'NOTICE', message: 'slow down' },
      { frame: 'CLOSED', message: 'auth-required: please auth' },
    ]);
    expect(auths).toEqual(['challenge-abc']);
    // Resubscribe sent a fresh REQ on the same socket.
    const reqs = sockets[0].sent.map((s) => JSON.parse(s)).filter((m) => m[0] === 'REQ');
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    await t.stop();
  });

  test('subscribe filter narrows to cells and reconnect without seen events keeps the 24h window', async () => {
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://cell.relay'],
      reconnectMs: 10,
      cells: ['abcde', 'fghij'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    await tick(20);
    const firstReq = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(firstReq[2]['#g']).toEqual(['abcde', 'fghij']);
    expect(firstReq[2].limit).toBe(500);
    const firstSince = firstReq[2].since as number;
    expect(firstSince).toBeLessThan(Math.floor(Date.now() / 1000) - 80000);
    sockets[0].close(); // reconnect, auto-opens
    await tick(50);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const secondReq = sockets[1].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(secondReq[2]['#g']).toEqual(['abcde', 'fghij']);
    // No event was ever seen, so the replay window must NOT advance
    // with subscribe time: the reconnect still replays the last 24h,
    // otherwise events published while the socket flapped are skipped.
    expect(secondReq[2].since as number).toBeLessThanOrEqual(firstSince + 120);
    await t.stop();
  });

  test('reconnect replays from the last main-subscription event minus overlap, stable across empty resubscribes', async () => {
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://anchor.relay'],
      reconnectMs: 10,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
    });
    await t.start();
    await tick(20);
    const firstReq = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    // A main-subscription event arrives with a recent created_at.
    const keys = generateNostrKeypair();
    const seenAt = Math.floor(Date.now() / 1000) - 1000;
    const wrapped = wrapEvent(makePost('seen'), keys, seenAt);
    sockets[0].receive(['EVENT', firstReq[1], wrapped]);
    await tick(10);
    // First reconnect: the replay window anchors on the seen event.
    sockets[0].close();
    await tick(50);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const secondReq = sockets[1].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(secondReq[2].since as number).toBe(seenAt - 300);
    // Second reconnect with no new event: the window must NOT advance
    // with subscribe time, or events published between the two
    // reconnects that no replay delivered yet are skipped for good.
    sockets[1].close();
    await tick(50);
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    const thirdReq = sockets[2].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(thirdReq[2].since as number).toBe(seenAt - 300);
    // A newer main-subscription event advances the anchor.
    const newerAt = Math.floor(Date.now() / 1000) - 100;
    const wrappedNewer = wrapEvent(makePost('newer'), keys, newerAt);
    sockets[2].receive(['EVENT', thirdReq[1], wrappedNewer]);
    await tick(10);
    sockets[2].close();
    await tick(50);
    expect(sockets.length).toBeGreaterThanOrEqual(4);
    const fourthReq = sockets[3].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(fourthReq[2].since as number).toBe(newerAt - 300);
    await t.stop();
  });

  test('stop before start is a safe no-op', async () => {
    const { t } = makeTransport();
    await expect(t.stop()).resolves.toBeUndefined();
    await t.stop();
  });
});

describe('NostrTransport inbound edge cases', () => {
  test('malformed JSON is dropped without emitting', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    sockets[0].onmessage?.({ data: 'not json{{{broken' });
    await tick(10);
    expect(count).toBe(0);
    await t.stop();
  });

  test('non-EVENT relay messages are ignored', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    sockets[0].receive(['EOSE', 'sub1']);
    sockets[0].receive(['NOTICE', 'bye']);
    sockets[0].receive(['CLOSED', 'sub1', 'auth-required: we do not do auth']);
    await tick(10);
    expect(count).toBe(0);
    await t.stop();
  });

  test('EVENT without a payload is ignored', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    sockets[0].receive(['EVENT', 'sub1']);
    await tick(10);
    expect(count).toBe(0);
    await t.stop();
  });

  test('oversize relay message is dropped before parsing', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    sockets[0].onmessage?.({ data: 'x'.repeat(70000) });
    await tick(10);
    expect(count).toBe(0);
    await t.stop();
  });

  test('EVENT with malformed envelope is ignored and later frames still deliver', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    let count = 0;
    t.onReceive(() => {
      count++;
    });
    const keys = generateNostrKeypair();
    const good = wrapEvent(makePost('good frame'), keys);
    // tags null previously threw out of the socket handler.
    expect(() =>
      sockets[0].receive(['EVENT', 'sub1', { ...good, tags: null }]),
    ).not.toThrow();
    sockets[0].receive(['EVENT', 'sub1', good]);
    await tick(10);
    expect(count).toBe(1);
    await t.stop();
  });

  test('queryByIds with an empty list sends nothing', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const sentBefore = sockets[0].sent.length;
    await t.queryByIds([]);
    await tick(20);
    expect(sockets[0].sent.length).toBe(sentBefore);
    await t.stop();
  });

  test('queryByIds caps the filter at 100 ids', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const ids = Array.from({ length: 150 }, (_, i) => String(i).padStart(64, '0'));
    await t.queryByIds(ids as never);
    const req = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((m) => m[0] === 'REQ' && m[2] && '#e' in m[2]);
    expect(req[2]['#e']).toHaveLength(100);
    await t.stop();
  });

  test('query CLOSE owed to a down relay is sent when its socket next opens', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const t = new NostrTransport({
        relays: ['wss://test.relay'],
        reconnectMs: 10,
        // No auto-open: the test drives open/close timing by hand.
        wsFactory: (url: string) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
      });
      await t.start();
      sockets[0].open();
      await t.queryByIds(['aa'.repeat(32)]);
      expect(
        sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ'),
      ).toBeDefined();
      // Drop before the 5 s close timer: reconnect is scheduled, but the
      // new socket stays shut until the test opens it after the timer.
      sockets[0].close();
      jest.advanceTimersByTime(20);
      expect(sockets).toHaveLength(2);
      jest.advanceTimersByTime(5000);
      // Timer fired while the new socket was down: no CLOSE yet.
      expect(sockets[1].sent).toHaveLength(0);
      sockets[1].open();
      const close = sockets[1].sent
        .map((s) => JSON.parse(s))
        .find((m) => m[0] === 'CLOSE');
      expect(close).toBeDefined();
      expect(close[1]).toBe('q2');
      await t.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('publish skips relays whose send throws; others still deliver', async () => {
    const { t, sockets } = makeTransport(['wss://bad.relay', 'wss://good.relay']);
    await t.start();
    await tick(20);
    const bad = sockets.find((s) => s.url === 'wss://bad.relay');
    expect(bad).toBeDefined();
    bad!.send = () => {
      throw new Error('broken pipe');
    };
    const urls = await t.publish(makePost('partial delivery'));
    expect(urls).toEqual(['wss://good.relay']);
    await t.stop();
  });

  test('getRelayState is closed for unknown relays', async () => {
    const { t } = makeTransport();
    expect(t.getRelayState('wss://never.relay')).toBe('closed');
    await t.stop();
  });

  test('handler errors on inbound EVENT do not break the transport', async () => {
    const { t, sockets } = makeTransport();
    const keys = generateNostrKeypair();
    await t.start();
    await tick(20);
    t.onReceive(() => {
      throw new Error('handler boom');
    });
    let ok = false;
    t.onReceive(() => {
      ok = true;
    });
    const wrapped = wrapEvent(makePost('resilient'), keys);
    expect(() => sockets[0].receive(['EVENT', 'sub1', wrapped])).not.toThrow();
    await tick(10);
    expect(ok).toBe(true);
    await t.stop();
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

describe('NostrTransport v0.1.27 load balancer', () => {
  test('rejection reason is carried in the ack, per relay', async () => {
    const { t, sockets } = makeTransport(['wss://a.relay', 'wss://b.relay']);
    await t.start();
    await tick(20);
    const event = makePost('rejected');
    const ackPromise = t.publishWithAck(event, 5000);
    await tick(10);
    const sentA = JSON.parse(sockets[0].sent.find((s) => s.includes('"EVENT"'))!);
    const sentB = JSON.parse(sockets[1].sent.find((s) => s.includes('"EVENT"'))!);
    sockets[0].receive(['OK', sentA[1].id, false, 'rate-limited: slow down']);
    sockets[1].receive(['OK', sentB[1].id, false, 'blocked: policy']);
    const ack = await ackPromise;
    expect(ack.ok).toEqual([]);
    expect(ack.rejected).toEqual(['wss://a.relay', 'wss://b.relay']);
    expect(ack.rejectionReasons).toEqual([
      { url: 'wss://a.relay', reason: 'rate-limited: slow down' },
      { url: 'wss://b.relay', reason: 'blocked: policy' },
    ]);
    await t.stop();
  });

  test('duplicate rejection reason is kept, not lost', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const ackPromise = t.publishWithAck(makePost('dup'), 5000);
    await tick(10);
    const sent = JSON.parse(sockets[0].sent.find((s) => s.includes('"EVENT"'))!);
    sockets[0].receive(['OK', sent[1].id, false, 'duplicate: already stored']);
    const ack = await ackPromise;
    expect(ack.rejected).toEqual(['wss://test.relay']);
    expect(ack.rejectionReasons).toEqual([
      { url: 'wss://test.relay', reason: 'duplicate: already stored' },
    ]);
    await t.stop();
  });

  test('per-socket replay anchors: a late relay replays from its own window, not the global one', async () => {
    const sockets: FakeSocket[] = [];
    const resubscribes: Array<{ since: number; relay: string; source: string }> = [];
    const t = new NostrTransport({
      relays: ['wss://a.relay', 'wss://b.relay'],
      reconnectMs: 10,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
      onResubscribe: (since, relayUrl, source) => {
        resubscribes.push({ since, relay: relayUrl, source });
      },
    });
    await t.start();
    await tick(20);
    // Relay A delivers an event with a recent created_at; relay B
    // delivers nothing. A reconnect of B must NOT use A's anchor:
    // events only B could have delivered would fall out of the window.
    const keys = generateNostrKeypair();
    const seenAt = Math.floor(Date.now() / 1000) - 1000;
    const reqA = sockets[0].sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    sockets[0].receive(['EVENT', reqA[1], wrapEvent(makePost('on A'), keys, seenAt)]);
    await tick(10);
    sockets[1].close(); // B reconnects; A stays up.
    await tick(50);
    const bSocket = sockets.find((s) => s.url === 'wss://b.relay' && s !== sockets[1]);
    expect(bSocket).toBeDefined();
    const reqB = bSocket!.sent.map((s) => JSON.parse(s)).find((m) => m[0] === 'REQ');
    expect(reqB[2].since as number).toBeLessThan(Math.floor(Date.now() / 1000) - 80000);
    const bResub = resubscribes.find((r) => r.relay === 'wss://b.relay');
    expect(bResub?.source).toBe('cap');
    // A reconnects: its window anchors on the event A actually saw.
    sockets[0].close();
    await tick(50);
    const aResub = resubscribes.filter((r) => r.relay === 'wss://a.relay').pop();
    expect(aResub?.source).toBe('anchor');
    expect(aResub?.since).toBe(seenAt - 300);
    await t.stop();
  });

  test('catchUpAuthors sends an authors REQ with no cell filter', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const author = 'cc'.repeat(32);
    const sent = await t.catchUpAuthors([author, 'not-hex', author], Math.floor(Date.now() / 1000) - 3600);
    expect(sent).toBe(true);
    const req = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((m) => m[0] === 'REQ' && m[2] && 'authors' in m[2]);
    expect(req).toBeDefined();
    expect(req[2].authors).toEqual([author]);
    expect(req[2]['#g']).toBeUndefined();
    await t.stop();
  });

  test('catchUpAuthors with no valid authors sends nothing', async () => {
    const { t, sockets } = makeTransport();
    await t.start();
    await tick(20);
    const sent = await t.catchUpAuthors(['nope'], 0);
    expect(sent).toBe(false);
    const req = sockets[0].sent
      .map((s) => JSON.parse(s))
      .find((m) => m[0] === 'REQ' && m[2] && 'authors' in m[2]);
    expect(req).toBeUndefined();
    await t.stop();
  });

  test('backed-off relay is skipped by publishes and online, but still receives', async () => {
    const { t } = makeTransport(['wss://a.relay', 'wss://b.relay']);
    await t.start();
    await tick(20);
    expect(t.online).toBe(true);
    t.setRelayBackoff('wss://a.relay', Date.now() + 60_000);
    const urls = await t.publish(makePost('backed off'));
    expect(urls).toEqual(['wss://b.relay']);
    // Both backed off: no live relay for a publish.
    t.setRelayBackoff('wss://b.relay', Date.now() + 60_000);
    expect(t.online).toBe(false);
    expect(await t.publish(makePost('nowhere'))).toEqual([]);
    // Expiry re-probes: online again without any reconnect.
    t.setRelayBackoff('wss://a.relay', Date.now() - 1);
    t.setRelayBackoff('wss://b.relay', Date.now() - 1);
    expect(t.online).toBe(true);
    await t.stop();
  });
});

describe('NostrTransport v0.1.31 lifecycle hooks + startIfNeeded', () => {
  test('a connect failure fires onConnectFailure with the relay and reason, and arms exactly one reconnect', async () => {
    const failures: Array<{ url: string; reason: string }> = [];
    const scheduled: Array<{ url: string; delayMs: number; attempt: number }> = [];
    const t = new NostrTransport({
      relays: ['wss://fail.relay'],
      reconnectMs: 1000,
      wsFactory: () => {
        throw new Error('dial failed');
      },
      onConnectFailure: (url, reason) => {
        failures.push({ url, reason });
      },
      onReconnectScheduled: (url, delayMs, attempt) => {
        scheduled.push({ url, delayMs, attempt });
      },
    });
    await t.start();
    await tick(20);
    expect(failures).toHaveLength(1);
    expect(failures[0].url).toBe('wss://fail.relay');
    expect(failures[0].reason).toContain('dial failed');
    // Exactly one reconnect is scheduled, and the pool reports it:
    // the v0.1.30 window showed zero lines for a dead pool, so the
    // ladder state must be observable, not just internal.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].url).toBe('wss://fail.relay');
    expect(scheduled[0].attempt).toBe(1);
    expect(t.openRelayCount()).toBe(0);
    expect(t.pendingReconnectCount()).toBe(1);
    expect(t.getLastConnectAttemptMs()).toBeGreaterThan(0);
    await t.stop();
    expect(t.pendingReconnectCount()).toBe(0);
  });

  test('a socket close fires onSocketClosed once with reason closed and arms exactly one reconnect', async () => {
    const closed: Array<{ url: string; reason: string }> = [];
    const scheduled: Array<{ url: string; delayMs: number; attempt: number }> = [];
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://flaky.relay'],
      reconnectMs: 1000,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
      onSocketClosed: (url, reason) => {
        closed.push({ url, reason });
      },
      onReconnectScheduled: (url, delayMs, attempt) => {
        scheduled.push({ url, delayMs, attempt });
      },
    });
    await t.start();
    await tick(20);
    expect(t.getRelayState('wss://flaky.relay')).toBe('open');
    sockets[0].close();
    // The error path and the later onclose must not double-log or
    // double-arm the ladder (pre-existing double schedule, fixed in
    // the same change that added the hooks).
    expect(closed).toEqual([{ url: 'wss://flaky.relay', reason: 'closed' }]);
    expect(scheduled).toHaveLength(1);
    expect(t.pendingReconnectCount()).toBe(1);
    await t.stop();
  });

  test('a silence timeout fires onSocketClosed with reason silence timeout', async () => {
    const closed: Array<{ url: string; reason: string }> = [];
    const sockets: FakeSocket[] = [];
    const t = new NostrTransport({
      relays: ['wss://silent.relay'],
      reconnectMs: 10,
      silenceTimeoutMs: 30,
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 0);
        return s;
      },
      onSocketClosed: (url, reason) => {
        closed.push({ url, reason });
      },
    });
    await t.start();
    await tick(20);
    expect(t.getRelayState('wss://silent.relay')).toBe('open');
    // Break the close-to-onclose link, as in the error-path test: the
    // silence force-close then runs the direct close path with the
    // silence reason. (When close() fires onclose synchronously, the
    // onclose 'closed' reason wins instead, and the direct path is
    // skipped: one close, one reason, never both.)
    sockets[0].close = () => {
      sockets[0].closed = true;
    };
    await tick(120);
    expect(closed[0]).toEqual({ url: 'wss://silent.relay', reason: 'silence timeout' });
    await t.stop();
  });

  test('startIfNeeded restarts a stopped pool and is a no-op while the pool is live', async () => {
    const { t, sockets } = makeTransport(['wss://a.relay']);
    await t.start();
    await tick(20);
    expect(sockets).toHaveLength(1);
    t.startIfNeeded();
    await tick(20);
    expect(sockets).toHaveLength(1);
    await t.stop();
    t.startIfNeeded();
    await tick(20);
    expect(sockets).toHaveLength(2);
    expect(t.getRelayState('wss://a.relay')).toBe('open');
    await t.stop();
  });
});
