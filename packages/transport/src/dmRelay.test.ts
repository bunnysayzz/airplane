// SPDX-License-Identifier: Apache-2.0
// WsDmRelay tests: subscription reconnect, publish socket close/error paths.
// Relays are fully mocked; no network touches this file.

import { ed25519 } from '@noble/curves/ed25519.js';
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

  test('sequential first-OK-wins order is unchanged: an OK still resolves true', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('ok me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string };
    sockets[0].receive(['OK', event.id, true]);
    await expect(result).resolves.toBe(true);
    expect(sockets[0].closed).toBe(true);
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
