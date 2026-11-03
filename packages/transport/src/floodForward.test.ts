// SPDX-License-Identifier: Apache-2.0
// BLE flood forwarding for posts: a bridge phone re-broadcasts a
// BLE-received post to its other connected peers, with TTL decrement,
// seen-set dedup, sampled jitter, ingress link exclusion, and no
// forwarding of DM frames. Frame format is unchanged, so older
// installs receive forwarded posts but do not forward them.

import {
  encodeEvent,
  fragment,
  fragmentTagged,
  parseHeader,
  toHex,
  DEFAULT_TTL,
  FRAG_FLAG_DM,
  FRAG_WIRE_MAX,
  type SignedEvent,
  type TransportPort,
} from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
import { BleTransport } from './hybrid';

/** Fake port with a controllable connected-peer set. */
class FakeBlePort implements TransportPort {
  sent: { peerId: string; bytes: Uint8Array }[] = [];
  connected: string[] = [];
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
  connectedPeerIds(): string[] {
    return [...this.connected];
  }
  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }
  inject(peerId: string, bytes: Uint8Array): void {
    for (const cb of this.receivers) cb(peerId, bytes);
  }
}

function injectEvent(port: FakeBlePort, peerId: string, event: SignedEvent, ttl: number): void {
  for (const frame of fragment(encodeEvent(event), ttl, FRAG_WIRE_MAX)) {
    port.inject(peerId, frame);
  }
}

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

describe('BLE flood forwarding', () => {
  test('forwards a BLE post to connected peers except the ingress peer, with TTL decremented', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const forwarded: { eventId: string; peers: number; ttl: number }[] = [];
    const ble = new BleTransport(port, {
      floodForwardDelayMs: 0,
      onFloodForward: (eventId, peers, ttl) => forwarded.push({ eventId, peers, ttl }),
    });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });

    const event = makePost('bridge post');
    injectEvent(port, 'peerA', event, 7);
    expect(received).toHaveLength(1);
    await tick();
    const targets = new Set(port.sent.map((s) => s.peerId));
    expect(targets).toEqual(new Set(['peerC']));
    expect(port.sent.length).toBeGreaterThan(0);
    expect(parseHeader(port.sent[0].bytes).ttl).toBe(6);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].ttl).toBe(6);
    expect(forwarded[0].peers).toBe(1);
    await ble.stop();
  });

  test('does not forward when the decremented TTL reaches zero', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodForwardDelayMs: 0 });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    injectEvent(port, 'peerA', makePost('last hop'), 1);
    expect(received).toHaveLength(1);
    await tick();
    expect(port.sent).toHaveLength(0);
    await ble.stop();
  });

  test('does not forward a TTL zero event at all', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodForwardDelayMs: 0 });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    injectEvent(port, 'peerA', makePost('dead ttl'), 0);
    expect(received).toHaveLength(1);
    await tick();
    expect(port.sent).toHaveLength(0);
    await ble.stop();
  });

  test('a duplicate overheard before the jitter fires cancels the forward', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodForwardDelayMs: 100 });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    const event = makePost('overheard');
    injectEvent(port, 'peerA', event, 7);
    expect(ble.pendingFloodForwardCount).toBe(1);
    // Another relay carried it onward before our jitter fired.
    injectEvent(port, 'peerC', event, 6);
    expect(received).toHaveLength(1);
    expect(ble.pendingFloodForwardCount).toBe(0);
    await tick(200);
    expect(port.sent).toHaveLength(0);
    await ble.stop();
  });

  test('DM frames (flags 1) are never forwarded, and never delivered on the feed path', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodForwardDelayMs: 0 });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    const frames = fragmentTagged(new Uint8Array([1, 2, 3, 4, 5]), 12345, 7, FRAG_WIRE_MAX, FRAG_FLAG_DM);
    for (const frame of frames) port.inject('peerA', frame);
    await tick();
    expect(received).toHaveLength(0);
    expect(port.sent).toHaveLength(0);
    await ble.stop();
  });

  test('non-flood kinds are delivered locally but never re-flooded', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodForwardDelayMs: 0 });
    await ble.start();
    const received: SignedEvent[] = [];
    ble.onReceive((e) => {
      received.push(e);
    });
    const star = { ...makePost('a star, not a post'), kind: 4 as const };
    injectEvent(port, 'peerA', star, 7);
    expect(received).toHaveLength(1);
    await tick();
    expect(port.sent).toHaveLength(0);
    await ble.stop();
  });

  test('forward uses the sampled jitter when no fixed delay is given', async () => {
    const port = new FakeBlePort();
    port.connected = ['peerA', 'peerC'];
    const ble = new BleTransport(port, { floodJitterRand: () => 0 });
    await ble.start();
    ble.onReceive(() => {});
    injectEvent(port, 'peerA', makePost('jittered'), 7);
    expect(ble.pendingFloodForwardCount).toBe(1);
    await tick(80);
    expect(port.sent.length).toBeGreaterThan(0);
    await ble.stop();
  });

  test('origin broadcast still uses the origin TTL', async () => {
    const port = new FakeBlePort();
    const ble = new BleTransport(port);
    await ble.start();
    const event = makePost('origin');
    const sent = await ble.broadcast(event, ['peerX']);
    expect(sent).toBe(1);
    expect(parseHeader(port.sent[0].bytes).ttl).toBe(DEFAULT_TTL);
    expect(toHex(event.id)).toBeTruthy();
    await ble.stop();
  });
});
