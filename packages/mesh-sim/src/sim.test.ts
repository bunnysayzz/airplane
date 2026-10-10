// SPDX-License-Identifier: Apache-2.0
// SimMedium / SimTransport / SimNetwork behavior tests (blueprint TEST-1/TEST-2).

import { SimTransport, SimNetwork, randomPeerId } from './sim';
import type { PeerInfo } from '@airplane/protocol';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function collect(transport: SimTransport): { received: { from: string; bytes: Uint8Array }[]; stop: () => void } {
  const received: { from: string; bytes: Uint8Array }[] = [];
  const stop = transport.onReceive((from, bytes) => {
    received.push({ from, bytes });
  });
  return { received, stop };
}

describe('SimNetwork 3-peer broadcast', () => {
  test('one peer broadcasts, other two receive identical bytes', async () => {
    const net = new SimNetwork();
    const a = net.createPeer('a');
    const b = net.createPeer('b');
    const c = net.createPeer('c');
    const rb = collect(b.transport);
    const rc = collect(c.transport);
    const ra = collect(a.transport);

    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    net.medium.broadcast(a.peerId, payload);
    await tick(50);

    expect(ra.received).toHaveLength(0); // sender does not receive its own broadcast
    expect(rb.received).toHaveLength(1);
    expect(rc.received).toHaveLength(1);
    expect(rb.received[0].from).toBe(a.peerId);
    expect(rc.received[0].from).toBe(a.peerId);
    expect(Array.from(rb.received[0].bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(rc.received[0].bytes)).toEqual([1, 2, 3, 4, 5]);

    ra.stop();
    rb.stop();
    rc.stop();
  });

  test('unicast reaches only the addressed peer', async () => {
    const net = new SimNetwork();
    const a = net.createPeer('a');
    const b = net.createPeer('b');
    const c = net.createPeer('c');
    const rb = collect(b.transport);
    const rc = collect(c.transport);

    net.medium.unicast(a.peerId, c.peerId, new Uint8Array([9]));
    await tick(50);

    expect(rb.received).toHaveLength(0);
    expect(rc.received).toHaveLength(1);
    expect(rc.received[0].from).toBe(a.peerId);

    rb.stop();
    rc.stop();
  });
});

describe('SimMedium loss and latency', () => {
  test('dropRate: 1 drops everything', async () => {
    const net = new SimNetwork({ dropRate: 1 });
    const a = net.createPeer('a');
    const b = net.createPeer('b');
    const { received, stop } = collect(b.transport);

    net.medium.broadcast(a.peerId, new Uint8Array([1]));
    net.medium.unicast(a.peerId, b.peerId, new Uint8Array([2]));
    await tick(50);

    expect(received).toHaveLength(0);
    stop();
  });

  test('latency is respected (elapsed >= latencyMs)', async () => {
    const latencyMs = 60;
    const net = new SimNetwork({ latencyMs });
    const a = net.createPeer('a');
    const b = net.createPeer('b');

    const arrived = new Promise<number>((resolve) => {
      const t0 = Date.now();
      b.transport.onReceive(() => resolve(Date.now() - t0));
    });
    net.medium.unicast(a.peerId, b.peerId, new Uint8Array([7]));
    const elapsed = await arrived;
    // setTimeout may fire ~1 ms early on some platforms; keep a small margin.
    expect(elapsed).toBeGreaterThanOrEqual(latencyMs - 5);
  });
});

describe('SimTransport connection state', () => {
  test('send throws when not connected; works after connect', async () => {
    const net = new SimNetwork();
    const a = net.createPeer('a');
    const b = net.createPeer('b');
    const { received, stop } = collect(b.transport);

    await expect(a.transport.send(b.peerId, new Uint8Array([1]))).rejects.toThrow(
      /not connected/,
    );

    await a.transport.connect(b.peerId);
    expect(a.transport.isConnected(b.peerId)).toBe(true);
    await a.transport.send(b.peerId, new Uint8Array([1, 2]));
    await tick(50);
    expect(received).toHaveLength(1);
    expect(Array.from(received[0].bytes)).toEqual([1, 2]);

    await a.transport.disconnect(b.peerId);
    expect(a.transport.isConnected(b.peerId)).toBe(false);
    await expect(a.transport.send(b.peerId, new Uint8Array([3]))).rejects.toThrow(
      /not connected/,
    );
    stop();
  });

  test('scan lists all registered peers', async () => {
    const net = new SimNetwork();
    const a = net.createPeer('a');
    const b = net.createPeer('b');
    const c = net.createPeer('c');
    expect(net.peerCount()).toBe(3);

    const peers: PeerInfo[] = [];
    const stopScan = await a.transport.scan((p) => peers.push(p));
    expect(peers).toHaveLength(3);
    const ids = peers.map((p) => p.peerId).sort();
    expect(ids).toEqual([a.peerId, b.peerId, c.peerId].sort());
    for (const p of peers) {
      expect(p.rssi).toBe(-50);
      expect(typeof p.lastSeenSec).toBe('number');
    }
    expect(typeof stopScan).toBe('function');
    stopScan();
  });

  test('unregistering via onReceive cleanup removes the peer', async () => {
    const net = new SimNetwork();
    const a = net.createPeer('a');
    net.createPeer('b');
    const { stop } = collect(a.transport);
    expect(net.peerCount()).toBe(2);
    stop();
    expect(net.peerCount()).toBe(1);
  });
});

describe('randomPeerId', () => {
  test('produces 16-char lowercase hex ids, unique across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomPeerId()));
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
