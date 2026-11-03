// SPDX-License-Identifier: Apache-2.0
// Rank 4 tests: DM pool silence timer and CLOSED resubscribe.
// Relays are fully mocked; no network touches this file.

import { WsDmRelay } from './dmRelay';
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
}

function makeRelay(sockets: FakeSocket[], silenceTimeoutMs: number): WsDmRelay {
  return new WsDmRelay({
    relays: ['wss://test.relay'],
    wsFactory: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    publishTimeoutMs: 1000,
    reconnectMs: 100,
    reconnectMaxMs: 100,
    silenceTimeoutMs,
  });
}

describe('rank 4: DM pool silence and CLOSED', () => {
  test('a silent socket is force-closed and reconnects with a fresh REQ', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const relay = makeRelay(sockets, 1000);
      const ownHex = 'a'.repeat(64);
      const unsub = relay.subscribe(ownHex, () => {});
      sockets[0].open();
      expect(sockets[0].sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);
      // No frame for the silence window: the socket must be closed.
      await jest.advanceTimersByTimeAsync(1000);
      expect(sockets[0].closed).toBe(true);
      // Reconnect (100 ms backoff) opens a replacement with a fresh REQ.
      await jest.advanceTimersByTimeAsync(100);
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      expect(sockets[1].sent.filter(s => JSON.parse(s)[0] === 'REQ')).toHaveLength(1);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  test('any inbound frame resets the silence window', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const relay = makeRelay(sockets, 1000);
      const ownHex = 'b'.repeat(64);
      const unsub = relay.subscribe(ownHex, () => {});
      sockets[0].open();
      await jest.advanceTimersByTimeAsync(900);
      // A NOTICE frame proves liveness, even though it carries no event.
      sockets[0].receive(['NOTICE', 'hello']);
      await jest.advanceTimersByTimeAsync(900);
      expect(sockets[0].closed).toBe(false);
      await jest.advanceTimersByTimeAsync(200);
      expect(sockets[0].closed).toBe(true);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a CLOSED for the live subscription resubscribes at once on the same socket', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets, 90000);
    const ownHex = 'c'.repeat(64);
    const unsub = relay.subscribe(ownHex, () => {});
    sockets[0].open();
    const reqsBefore = sockets[0].sent.filter(s => JSON.parse(s)[0] === 'REQ').length;
    expect(reqsBefore).toBe(1);
    sockets[0].receive(['CLOSED', `dm-${ownHex.slice(0, 8)}`, 'killed']);
    const reqsAfter = sockets[0].sent.filter(s => JSON.parse(s)[0] === 'REQ').length;
    expect(reqsAfter).toBe(2);
    expect(sockets[0].closed).toBe(false);
    unsub();
  });

  test('a CLOSED for another subscription id is ignored', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets, 90000);
    const ownHex = 'd'.repeat(64);
    const unsub = relay.subscribe(ownHex, () => {});
    sockets[0].open();
    sockets[0].receive(['CLOSED', 'dm-other', 'killed']);
    const reqs = sockets[0].sent.filter(s => JSON.parse(s)[0] === 'REQ').length;
    expect(reqs).toBe(1);
    unsub();
  });
});
