// SPDX-License-Identifier: Apache-2.0
// BleTransport + HybridTransport tests. BLE is mocked via TransportPort;
// Nostr relays are mocked via the FakeSocket from nostr.test.

import {
  encodeEvent,
  toHex,
  type SignedEvent,
  type TransportPort,
} from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
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

  /** Simulate an inbound frame from a peer. */
  inject(peerId: string, bytes: Uint8Array): void {
    for (const cb of this.receivers) cb(peerId, bytes);
  }
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

describe('BleTransport', () => {
  test('inbound CBOR frame is decoded and emitted once', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });

    const event = makePost('ble hello');
    port.inject('peer1', encodeEvent(event));
    await tick();

    expect(received).toHaveLength(1);
    expect(toHex(received[0].id)).toBe(toHex(event.id));
    await ble.stop();
  });

  test('duplicate inbound frame is suppressed (loop suppression)', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();

    let count = 0;
    ble.onReceive(() => {
      count++;
    });

    const bytes = encodeEvent(makePost('dup'));
    port.inject('peer1', bytes);
    port.inject('peer2', bytes); // same event, different peer
    await tick();

    expect(count).toBe(1);
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
