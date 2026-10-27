// SPDX-License-Identifier: Apache-2.0
// BleTransport + HybridTransport tests. BLE is mocked via TransportPort;
// Nostr relays are mocked via the FakeSocket from nostr.test.

import {
  encodeEvent,
  fragment,
  toHex,
  verifyEvent,
  NobleCrypto,
  DEFAULT_TTL,
  FRAG_WIRE_MAX,
  type SignedEvent,
  type TransportPort,
} from '@airplane/protocol';
import { makePost, makeSizedEvent } from '../../protocol/src/test-helpers';
import { decodeEvent } from '@airplane/protocol';
import { BleTransport, HybridTransport, type IngressSource } from './hybrid';

/** Minimal in-memory TransportPort (loopback between "peers" not needed). */
class FakeBlePort implements TransportPort {
  sent: { peerId: string; bytes: Uint8Array }[] = [];
  private receivers = new Set<(peerId: string, bytes: Uint8Array) => void>();

  async advertise(): Promise<void> {}
  async stopAdvertise(): Promise<void> {}
  async scan(): Promise<() => void> {
    return () => {};
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    this.sent.push({ peerId, bytes });
  }
  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }

  /** How many receive callbacks are currently registered (lifecycle tests). */
  get receiverCount(): number {
    return this.receivers.size;
  }

  /** Simulate an inbound frame from a peer. */
  inject(peerId: string, bytes: Uint8Array): void {
    for (const cb of this.receivers) cb(peerId, bytes);
  }
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Inject a whole event as wire frames (what a real port delivers).
 * Frames can be shuffled to simulate out-of-order ATT delivery.
 */
function injectEvent(
  port: FakeBlePort,
  peerId: string,
  event: SignedEvent,
  opts?: { mtu?: number; shuffle?: boolean },
): void {
  const frames = fragment(encodeEvent(event), DEFAULT_TTL, opts?.mtu ?? FRAG_WIRE_MAX);
  const ordered = opts?.shuffle ? [...frames].reverse() : frames;
  for (const frame of ordered) port.inject(peerId, frame);
}

describe('BleTransport', () => {
  test('inbound wire frames reassemble and decode to one event', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });

    const event = makePost('ble hello');
    injectEvent(port, 'peer1', event);

    expect(received).toHaveLength(1);
    expect(toHex(received[0].id)).toBe(toHex(event.id));
    await ble.stop();
  });

  test('verify: a valid signed event passes, tampered events are dropped (T11 §23.6)', async () => {
    const port = new FakeBlePort();
    const crypto = new NobleCrypto();
    const ble = new BleTransport(port, {
      verify: (event) => verifyEvent(crypto, event),
    });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });

    injectEvent(port, 'peer1', makePost('genuine'));
    expect(received).toHaveLength(1);

    const genuine = makePost('victim');
    const badSig = new Uint8Array(genuine.sig);
    badSig[0] ^= 1;
    injectEvent(port, 'peer1', { ...genuine, sig: badSig });
    expect(received).toHaveLength(1); // flipped signature: dropped

    injectEvent(port, 'peer1', { ...makePost('other'), content: 'tampered' });
    expect(received).toHaveLength(1); // content/id mismatch: dropped
    await ble.stop();
  });

  test('verify: a throwing verifier drops the event without breaking the transport', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port, {
      verify: () => {
        throw new Error('verifier blew up');
      },
    });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    injectEvent(port, 'peer1', makePost('hello'));
    expect(received).toHaveLength(0);
    await ble.stop(); // still stops cleanly
  });

  test('fragments arriving out of order still reassemble', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });

    // ~2KB event -> several frames at the default wire size.
    const event = decodeEvent(makeSizedEvent(2000));
    injectEvent(port, 'peer1', event, { shuffle: true });

    expect(received).toHaveLength(1);
    expect(toHex(received[0].id)).toBe(toHex(event.id));
    await ble.stop();
  });

  test('duplicate inbound event is suppressed (loop suppression)', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    let count = 0;
    ble.onReceive(() => {
      count++;
    });

    const event = makePost('dup');
    injectEvent(port, 'peer1', event);
    injectEvent(port, 'peer2', event); // same event, different peer

    expect(count).toBe(1);
    await ble.stop();
  });

  test('dedup hook reports the dropping peer for loop suppression (R2)', async () => {
    const port = new FakeBlePort();
    const dropped: string[] = [];
    const ble = new BleTransport(port, {
      onDedupDrop: (peerId) => {
        dropped.push(peerId);
      },
    });
    await ble.start();

    let count = 0;
    ble.onReceive(() => {
      count++;
    });

    const event = makePost('dup-hook');
    injectEvent(port, 'peer1', event);
    injectEvent(port, 'peer2', event); // same event, different peer

    expect(count).toBe(1);
    expect(dropped).toEqual(['peer2']);
    await ble.stop();
  });

  test('malformed frame is dropped without emitting', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    let count = 0;
    ble.onReceive(() => {
      count++;
    });
    port.inject('peer1', new Uint8Array([0xff, 0xfe, 0x00]));
    await tick();

    expect(count).toBe(0);
    await ble.stop();
  });

  test('broadcast encodes and sends to each peer', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    const event = makePost('broadcast me');
    await ble.broadcast(event, ['p1', 'p2']);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[0].peerId).toBe('p1');

    // Our own broadcast must not echo back as "new".
    let count = 0;
    ble.onReceive(() => {
      count++;
    });
    port.inject('p1', port.sent[0].bytes);
    await tick();
    expect(count).toBe(0);
    await ble.stop();
  });

  test('broadcast fragments large events to the port frame size (MTU-aware)', async () => {
    // Port reports a small link MTU: every frame must fit it.
    class SmallMtuPort extends FakeBlePort {
      frameSizeFor(): number {
        return 64;
      }
    }
    const port = new SmallMtuPort();
    const ble = new BleTransport(port);
    await ble.start();

    const event = decodeEvent(makeSizedEvent(2000));
    await ble.broadcast(event, ['p1']);
    expect(port.sent.length).toBeGreaterThan(1);
    for (const { bytes } of port.sent) {
      expect(bytes.length).toBeLessThanOrEqual(64);
    }

    // A remote BleTransport fed those exact frames reassembles the event.
    const remotePort = new FakeBlePort();
    const remote = new BleTransport(remotePort);
    await remote.start();
    const got: SignedEvent[] = [];
    remote.onReceive((e) => got.push(e));
    for (const { bytes } of port.sent) remotePort.inject('p1', bytes);
    expect(got).toHaveLength(1);
    expect(toHex(got[0].id)).toBe(toHex(event.id));
    await ble.stop();
    await remote.stop();
  });

  test('start/stop is idempotent', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();
    await ble.start(); // second start is a no-op
    expect(port.receiverCount).toBe(1);
    await ble.stop();
    await ble.stop(); // second stop is safe
    expect(port.receiverCount).toBe(0);
  });
});

describe('HybridTransport', () => {
  function makeHybrid() {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    // Nostr with no relays configured: never online, publish is a no-op.
    // For controlled tests we drive ingress() directly.
    const h = new HybridTransport(ble, { relays: [] });
    return { h, port, ble };
  }

  test('ingress emits once; cross-transport duplicate is dropped', async () => {
    const { h } = makeHybrid();
    await h.start();

    const seen: { id: string; source: IngressSource }[] = [];
    h.onPost((e, source) => {
      seen.push({ id: toHex(e.id), source });
    });

    const event = makePost('hybrid dedup');
    expect(h.ingress(event, 'ble')).toBe(true);
    expect(h.ingress(event, 'nostr')).toBe(false); // same id via nostr
    expect(h.ingress(event, 'ble')).toBe(false); // same id via ble again

    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('ble');
    await h.stop();
  });

  test('dedup hook reports source and peer for cross-transport drops (R2)', async () => {
    const dropped: { source: IngressSource; peerId: string | null }[] = [];
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    const h = new HybridTransport(ble, undefined, {
      onDedupDrop: (source, peerId) => {
        dropped.push({ source, peerId });
      },
    });
    const event = makePost('hook-dup');
    expect(h.ingress(event, 'ble', 'peer1')).toBe(true);
    expect(h.ingress(event, 'nostr')).toBe(false);
    expect(h.ingress(event, 'ble', 'peer2')).toBe(false);
    expect(dropped).toEqual([
      { source: 'nostr', peerId: null },
      { source: 'ble', peerId: 'peer2' },
    ]);
    await h.stop();
  });

  test('BLE wire path feeds hybrid ingress once; nostr echo of the same event is dropped', async () => {
    // Full path: event -> fragments -> port -> BleTransport reassembly ->
    // hybrid ingress, then the same event arriving via nostr is a dup.
    const { h, port } = makeHybrid();
    await h.start();

    const seen: { id: string; source: IngressSource }[] = [];
    h.onPost((e, source) => {
      seen.push({ id: toHex(e.id), source });
    });

    const event = decodeEvent(makeSizedEvent(1200)); // multi-frame
    injectEvent(port, 'peer1', event);
    expect(seen).toHaveLength(1);
    expect(seen[0].source).toBe('ble');

    expect(h.ingress(event, 'nostr')).toBe(false);
    expect(seen).toHaveLength(1);
    await h.stop();
  });

  test('distinct events from both transports both emit', async () => {
    const { h } = makeHybrid();
    await h.start();

    const ids: string[] = [];
    h.onPost((e, source) => {
      ids.push(`${toHex(e.id).slice(0, 8)}:${source}`);
    });

    h.ingress(makePost('one'), 'ble');
    h.ingress(makePost('two'), 'nostr');
    expect(ids).toHaveLength(2);
    await h.stop();
  });

  test('publish fans out and emits locally exactly once', async () => {
    const { h, port } = makeHybrid();
    await h.start();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('publish fanout');
    const res = await h.publish(event, ['p1']);
    expect(res.blePeers).toBe(1);
    expect(res.relays).toEqual([]); // no relays configured
    expect(port.sent).toHaveLength(1);

    // Local echo emitted once.
    expect(seen).toEqual(['local']);

    // A BLE echo of our own publish is deduped, not re-emitted.
    h.ingress(event, 'ble');
    expect(seen).toEqual(['local']);
    await h.stop();
  });

  test('nostrOnline reflects relay connectivity', async () => {
    const { h } = makeHybrid();
    expect(h.nostrOnline).toBe(false);
    await h.start();
    expect(h.nostrOnline).toBe(false); // no relays -> never online
    await h.stop();
  });

  test('handler errors do not break ingress', async () => {
    const { h } = makeHybrid();
    await h.start();

    h.onPost(() => {
      throw new Error('boom');
    });
    let ok = false;
    h.onPost(() => {
      ok = true;
    });

    expect(() => h.ingress(makePost('x'), 'ble')).not.toThrow();
    expect(ok).toBe(true);
    await h.stop();
  });
});

describe('HybridTransport with live NostrTransport (mocked socket)', () => {
  /** Minimal fake socket with an inject hook for inbound messages. */
  class InjectableSocket {
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;

    constructor(private readonly autoOpen: boolean = true) {
      if (autoOpen) setTimeout(() => this.onopen?.({}), 0);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
    inject(msg: unknown[]): void {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }

  test('nostr inbound flows through hybrid ingress with dedup', async () => {
    const { wrapEvent, generateNostrKeypair } = await import('./nostr');
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    const sockets: InjectableSocket[] = [];
    const h = new HybridTransport(ble, {
      relays: ['wss://mock.relay'],
      reconnectMs: 10,
      wsFactory: () => {
        const s = new InjectableSocket();
        sockets.push(s);
        return s;
      },
    });
    await h.start();
    await tick(20);
    expect(h.nostrOnline).toBe(true);

    const seen: IngressSource[] = [];
    h.onPost((_e, s) => {
      seen.push(s);
    });

    const keys = generateNostrKeypair();
    const event = makePost('via mocked relay');
    const wrapped = wrapEvent(event, keys);
    sockets[0].inject(['EVENT', 'sub0', wrapped]);
    await tick(20);
    expect(seen).toEqual(['nostr']);

    // Same event arriving via BLE afterwards is deduped.
    h.ingress(event, 'ble');
    expect(seen).toEqual(['nostr']);
    await h.stop();
  });
});

describe('BleTransport lifecycle', () => {
  test('start is idempotent: a double start subscribes the port once', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();
    await ble.start();
    expect(port.receiverCount).toBe(1);

    // Inbound still decoded and emitted exactly once.
    let count = 0;
    ble.onReceive(() => {
      count++;
    });
    injectEvent(port, 'peer1', makePost('idempotent start'));
    await tick();
    expect(count).toBe(1);
    await ble.stop();
  });

  test('stop before start and double stop are safe no-ops', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await expect(ble.stop()).resolves.toBeUndefined();
    await ble.start();
    await ble.stop();
    expect(port.receiverCount).toBe(0);
    await expect(ble.stop()).resolves.toBeUndefined();
  });

  test('restart: start -> stop -> start receives again', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    let count = 0;
    ble.onReceive(() => {
      count++;
    });

    await ble.start();
    injectEvent(port, 'peer1', makePost('first life'));
    await tick();
    expect(count).toBe(1);

    await ble.stop();
    injectEvent(port, 'peer1', makePost('while stopped'));
    await tick();
    expect(count).toBe(1); // unsubscribed: nothing received while stopped

    await ble.start();
    injectEvent(port, 'peer1', makePost('second life'));
    await tick();
    expect(count).toBe(2);
    await ble.stop();
  });

  test('broadcast without start still suppresses the echo', async () => {
    // broadcast() does not require start(); the seen-marking holds anyway.
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    const event = makePost('unstated broadcast');
    await ble.broadcast(event, ['peer1']);
    expect(port.sent).toHaveLength(1);
    expect(ble.hasSeen(toHex(event.id))).toBe(true);
  });
});

describe('HybridTransport lifecycle', () => {
  function makeLifecycleHybrid() {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    // Nostr with no relays configured: never online; ingress driven directly.
    const h = new HybridTransport(ble, { relays: [] });
    return { h, port, ble };
  }

  test('double start is safe: ingress still emits exactly once', async () => {
    const { h } = makeLifecycleHybrid();
    await h.start();
    await h.start();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('double start');
    h.ingress(event, 'ble');
    h.ingress(event, 'nostr'); // duplicate across the doubled subscriptions
    expect(seen).toEqual(['ble']);
    await h.stop();
  });

  test('stop unsubscribes everything: post-stop frames never ingress', async () => {
    const { h, port } = makeLifecycleHybrid();
    await h.start();
    await h.stop();

    const seen: string[] = [];
    h.onPost((e) => {
      seen.push(toHex(e.id));
    });

    // A BLE frame after stop: BleTransport already unsubscribed the port,
    // so even well-formed frames never ingress.
    injectEvent(port, 'peer1', makePost('late frame'));
    await tick();
    expect(seen).toHaveLength(0);

    // Direct ingress() is transport-independent by design and still works.
    const direct = makePost('direct');
    expect(h.ingress(direct, 'local')).toBe(true);
    expect(seen).toEqual([toHex(direct.id)]);

    await expect(h.stop()).resolves.toBeUndefined(); // double stop safe
  });

  test('restart works end to end', async () => {
    const { h } = makeLifecycleHybrid();
    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    await h.start();
    h.ingress(makePost('first life'), 'ble');
    await h.stop();
    await h.start();
    h.ingress(makePost('second life'), 'nostr');
    expect(seen).toEqual(['ble', 'nostr']);
    await h.stop();
  });

  test('stop before start is a safe no-op', async () => {
    const { h } = makeLifecycleHybrid();
    await expect(h.stop()).resolves.toBeUndefined();
  });

  test('publish without any start still emits locally (no throw)', async () => {
    const { h, port } = makeLifecycleHybrid();
    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });
    const res = await h.publish(makePost('cold publish'), ['peer1']);
    expect(res.blePeers).toBe(1);
    expect(port.sent).toHaveLength(1);
    expect(seen).toEqual(['local']);
    await h.stop();
  });
});
