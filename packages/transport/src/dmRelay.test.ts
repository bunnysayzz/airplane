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
  DM_ACK_EVENT_KIND,
  dmAckEnvelopeToNostrEvent,
  dmEnvelopeToNostrEvent,
  nostrEventToDmAckEnvelope,
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

/**
 * Let pooled-publish microtasks land: a publish to a connecting socket
 * sends on the microtask after its open wait resolves, so tests that open
 * a socket and then read what it sent must yield once first.
 */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

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
    expect(req[2].kinds).toEqual([1059, 1060]);
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

  test('unsubscribe stops retries but keeps the pooled socket for publish', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const relay = makeRelay(sockets);
      const unsub = relay.subscribe('b'.repeat(64), () => {});
      sockets[0].open();
      unsub();
      // Pooled sockets stay open for publish; only EVENT routing stops.
      expect(sockets[0].closed).toBe(false);
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
  test('a close without OK resolves failed immediately, not at the timeout', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets, { publishTimeoutMs: 60000 });
    const envelope = sealDm('close me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    sockets[0].close();
    await expect(result).resolves.toEqual({ accepted: false, rejected: false });
  });

  test('an error resolves failed and closes the socket (no leak)', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('error me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    sockets[0].fail();
    await expect(result).resolves.toEqual({ accepted: false, rejected: false });
    expect(sockets[0].closed).toBe(true);
  });

  test('an explicit relay rejection settles at once as rejected, not at the timeout', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets, { publishTimeoutMs: 60000 });
    const envelope = sealDm('reject me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    await tick();
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string };
    // The old code ignored OK=false and burned the full timeout here.
    sockets[0].receive(['OK', event.id, false, 'restricted: kind not allowed']);
    await expect(result).resolves.toEqual({ accepted: false, rejected: true });
  });

  test('a send throw resolves failed; the pooled socket stays open', async () => {
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
    await expect(result).resolves.toEqual({ accepted: false, rejected: false });
    // Pooled sockets are shared with the subscription: one bad send
    // must not kill them. The socket closes only on error/close.
    expect(sockets[0].closed).toBe(false);
  });

  test('parallel first-OK-wins: an OK resolves true and the socket stays pooled', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('ok me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    await tick();
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string };
    sockets[0].receive(['OK', event.id, true]);
    await expect(result).resolves.toEqual({ accepted: true, rejected: false });
    expect(sockets[0].closed).toBe(false);
  });

  test('parallel first-OK-wins: a slow second relay never blocks the first OK', async () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://fast.relay', 'wss://slow.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      publishTimeoutMs: 60000,
    });
    const envelope = sealDm('race me', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publish(envelope);
    sockets[0].open();
    sockets[1].open();
    await tick();
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string };
    // The slow relay never answers at all: the first OK still wins now,
    // without waiting out the deadline.
    sockets[0].receive(['OK', event.id, true]);
    await expect(result).resolves.toEqual({ accepted: true, rejected: false });
  });
});

describe('WsDmRelay.publish event reuse on retry (F14-retry)', () => {
  test('publishing the same envelope twice sends the same event id over the pooled socket', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('retry me', 'd'.repeat(64), 'e'.repeat(64));
    const first = relay.publish(envelope);
    sockets[0].open();
    await tick();
    const firstEvent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const firstId = (firstEvent[1] as { id: string }).id;
    sockets[0].receive(['OK', firstId, true]);
    await expect(first).resolves.toEqual({ accepted: true, rejected: false });
    // Pooled: the second publish reuses the same socket, no new socket.
    const second = relay.publish(envelope);
    expect(sockets).toHaveLength(1);
    const secondEvent = JSON.parse(sockets[0].sent[1]) as unknown[];
    expect((secondEvent[1] as { id: string }).id).toBe(firstId);
    sockets[0].receive(['OK', firstId, true]);
    await expect(second).resolves.toEqual({ accepted: true, rejected: false });
  });
});

describe('WsDmRelay ack kind (delivery acks)', () => {
  test('ack events publish under the ack kind and route to the ack callback only', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const ownHex = 'a'.repeat(64);
    const received: DmEnvelope[] = [];
    const acks: DmEnvelope[] = [];
    const unsub = relay.subscribe(
      ownHex,
      e => {
        received.push(e);
      },
      e => {
        acks.push(e);
      },
    );
    sockets[0].open();
    const req = JSON.parse(sockets[0].sent[0]) as unknown[];
    const sender = ed25519.utils.randomSecretKey();
    const envelope = sealDm('ack me', dmToHex(ed25519.getPublicKey(sender)), ownHex);
    const ackEvent = dmAckEnvelopeToNostrEvent(envelope);
    expect(ackEvent.kind).toBe(DM_ACK_EVENT_KIND);
    sockets[0].receive(['EVENT', req[1], ackEvent]);
    expect(acks).toHaveLength(1);
    expect(received).toHaveLength(0);
    unsub();
  });

  test('publishAck sends the ack kind and resolves on OK', async () => {
    const sockets: FakeSocket[] = [];
    const relay = makeRelay(sockets);
    const envelope = sealDm('ack out', 'd'.repeat(64), 'e'.repeat(64));
    const result = relay.publishAck(envelope);
    sockets[0].open();
    await tick();
    const sent = JSON.parse(sockets[0].sent[0]) as unknown[];
    const event = sent[1] as { id: string; kind: number };
    expect(event.kind).toBe(DM_ACK_EVENT_KIND);
    sockets[0].receive(['OK', event.id, true]);
    await expect(result).resolves.toEqual({ accepted: true, rejected: false });
  });

  test('ack parsing rejects wrong-kind events and forged signatures', () => {
    const sender = ed25519.utils.randomSecretKey();
    const envelope = sealDm('ack real', dmToHex(ed25519.getPublicKey(sender)), 'c'.repeat(64));
    const ackEvent = dmAckEnvelopeToNostrEvent(envelope);
    expect(nostrEventToDmAckEnvelope(ackEvent)).not.toBeNull();
    // A 1059 message event is not an ack, even with a valid signature.
    expect(nostrEventToDmAckEnvelope(dmEnvelopeToNostrEvent(envelope))).toBeNull();
    const badSig = { ...ackEvent, sig: ackEvent.sig.slice(0, -1) + (ackEvent.sig.endsWith('0') ? '1' : '0') };
    expect(nostrEventToDmAckEnvelope(badSig)).toBeNull();
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

describe('WsDmRelay v0.1.31 pool state + lifecycle hooks', () => {
  test('getRelayUrls, getRelayState, and openRelayCount report the live pool', () => {
    const sockets: FakeSocket[] = [];
    const relay = new WsDmRelay({
      relays: ['wss://a.relay', 'wss://b.relay'],
      wsFactory: (url: string) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    expect(relay.getRelayUrls()).toEqual(['wss://a.relay', 'wss://b.relay']);
    const unsub = relay.subscribe('aa'.repeat(32), () => {});
    expect(relay.getRelayState('wss://a.relay')).toBe('connecting');
    expect(relay.openRelayCount()).toBe(0);
    sockets[0].open();
    expect(relay.getRelayState('wss://a.relay')).toBe('open');
    expect(relay.openRelayCount()).toBe(1);
    // The second relay got a socket from subscribe but never opened:
    // it is connecting, not closed.
    expect(relay.getRelayState('wss://b.relay')).toBe('connecting');
    expect(relay.getRelayState('wss://never.configured')).toBe('closed');
    unsub();
  });

  test('a socket close fires onSocketClosed with reason closed and schedules a reconnect', async () => {
    jest.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const closed: Array<{ url: string; reason: string }> = [];
      const scheduled: Array<{ url: string; delayMs: number; attempt: number }> = [];
      const opened: string[] = [];
      const relay = new WsDmRelay({
        relays: ['wss://test.relay'],
        wsFactory: (url: string) => {
          const s = new FakeSocket(url);
          sockets.push(s);
          return s;
        },
        onSocketOpen: (url) => {
          opened.push(url);
        },
        onSocketClosed: (url, reason) => {
          closed.push({ url, reason });
        },
        onReconnectScheduled: (url, delayMs, attempt) => {
          scheduled.push({ url, delayMs, attempt });
        },
      });
      const unsub = relay.subscribe('aa'.repeat(32), () => {});
      sockets[0].open();
      expect(opened).toEqual(['wss://test.relay']);
      sockets[0].close();
      // The DM pool recovered at 03:26:41 while the post pool stayed
      // dead in the v0.1.30 window, and no service line covered it:
      // the close reason and the scheduled reconnect must be visible
      // to the app, so it can log and re-attempt on them.
      expect(closed).toEqual([{ url: 'wss://test.relay', reason: 'closed' }]);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].url).toBe('wss://test.relay');
      expect(scheduled[0].attempt).toBe(1);
      expect(relay.openRelayCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(2000);
      expect(sockets).toHaveLength(2);
      unsub();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a connect failure fires onConnectFailure with the relay and reason', () => {
    const failures: Array<{ url: string; reason: string }> = [];
    const relay = new WsDmRelay({
      relays: ['wss://fail.relay'],
      wsFactory: () => {
        throw new Error('dial failed');
      },
      onConnectFailure: (url, reason) => {
        failures.push({ url, reason });
      },
    });
    const unsub = relay.subscribe('aa'.repeat(32), () => {});
    expect(failures).toHaveLength(1);
    expect(failures[0].url).toBe('wss://fail.relay');
    expect(failures[0].reason).toContain('dial failed');
    expect(relay.getRelayState('wss://fail.relay')).toBe('closed');
    unsub();
  });
});
