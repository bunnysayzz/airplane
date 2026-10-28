// SPDX-License-Identifier: Apache-2.0
// WsDmRelay tests: subscription reconnect, publish socket close/error paths,
// custom relay lists, bounded subscribe filters.
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

describe('WsDmRelay.publish event reuse on retry (F14-retry)', () => {
  test('publishing the same envelope twice sends the same event id', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('retry me', 'd'.repeat(64), 'e'.repeat(64));
    const first = relay.publish(envelope);
    sockets[0].open();
    const firstEvent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const firstId = (firstEvent[1] as { id: string }).id;
    sockets[0].receive(['OK', firstId, true]);
    await expect(first).resolves.toBe(true);
    const second = relay.publish(envelope);
    sockets[1].open();
    const secondEvent = JSON.parse(sockets[1].sent[0]) as unknown[];
    expect((secondEvent[1] as { id: string }).id).toBe(firstId);
    sockets[1].receive(['OK', firstId, true]);
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
