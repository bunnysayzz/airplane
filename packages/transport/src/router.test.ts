// SPDX-License-Identifier: Apache-2.0
// Ordered router (R4) tests: relay first, mesh fallback, queued when
// neither can send, dedup across the router boundary, relay OK handling.

import { type TransportPort } from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
import { BleTransport, HybridTransport, type IngressSource } from './hybrid';
import { NostrTransport } from './nostr';

/** Minimal in-memory TransportPort. */
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
}

/** Fake socket with manual open control and inbound injection. */
class InjectableSocket {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;

  open(): void {
    this.onopen?.({});
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.({});
  }
  inject(msg: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

function makeRouter(opts?: {
  relays?: string[];
  relayDeadlineMs?: number;
  networkValidated?: () => boolean;
}) {
  const port = new FakeBlePort();
  const ble = new BleTransport(port);
  const sockets: InjectableSocket[] = [];
  const h = new HybridTransport(
    ble,
    {
      relays: opts?.relays ?? ['wss://mock.relay'],
      reconnectMs: 10,
      wsFactory: () => {
        const s = new InjectableSocket();
        sockets.push(s);
        return s;
      },
    },
    undefined,
    {
      relayDeadlineMs: opts?.relayDeadlineMs ?? 50,
      networkValidated: opts?.networkValidated,
    },
  );
  return { h, port, sockets };
}

/** All EVENT messages a socket sent (the subscription REQ on open is not one). */
function sentEvents(socket: InjectableSocket): { id: string }[] {
  const events: { id: string }[] = [];
  for (const raw of socket.sent) {
    const msg = JSON.parse(raw) as unknown[];
    if (msg[0] === 'EVENT') events.push(msg[1] as { id: string });
  }
  return events;
}

/** Envelope id of the EVENT the router just sent on the socket. */
function sentEnvelopeId(socket: InjectableSocket): string {
  const events = sentEvents(socket);
  return events[events.length - 1].id;
}

describe('Ordered router publish', () => {
  test('relay OK wins: no BLE frames, status relayed, local echo once', async () => {
    const { h, port, sockets } = makeRouter();
    await h.start();
    sockets[0].open();
    await tick();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('relay wins');
    const pending = h.publish(event, ['p1']);
    await tick();
    expect(sentEvents(sockets[0])).toHaveLength(1);
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), true, '']);
    const res = await pending;

    expect(res.transport).toBe('relay');
    expect(res.status).toBe('relayed');
    expect(res.relays).toEqual(['wss://mock.relay']);
    expect(res.blePeers).toBe(0);
    expect(res.relayTried).toBe(true);
    expect(res.relayDetail).toBeNull();
    expect(port.sent).toHaveLength(0); // mesh never armed on a relay win
    expect(seen).toEqual(['local']);
    await h.stop();
  });

  test('relay OK timeout falls through to mesh with status sent', async () => {
    const { h, port, sockets } = makeRouter({ relayDeadlineMs: 50 });
    await h.start();
    sockets[0].open();
    await tick();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('relay timeout');
    const res = await h.publish(event, ['p1']); // no OK injected: deadline fires

    expect(res.transport).toBe('mesh');
    expect(res.status).toBe('sent'); // forward only, never backward to queued
    expect(res.blePeers).toBe(1);
    expect(res.relays).toEqual([]);
    expect(res.relayTried).toBe(true);
    expect(res.relayDetail).toMatch(/50ms/);
    expect(port.sent.length).toBeGreaterThan(0);
    expect(seen).toEqual(['local']);
    await h.stop();
  });

  test('relay OK rejection falls through to mesh', async () => {
    const { h, port, sockets } = makeRouter();
    await h.start();
    sockets[0].open();
    await tick();

    const event = makePost('relay rejects');
    const pending = h.publish(event, ['p1']);
    await tick();
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), false, 'rejected']);
    const res = await pending;

    expect(res.transport).toBe('mesh');
    expect(res.status).toBe('sent');
    expect(res.relayTried).toBe(true);
    expect(res.relayDetail).toBe('relays rejected the event');
    expect(port.sent.length).toBeGreaterThan(0);
    await h.stop();
  });

  test('no relay socket falls through to mesh immediately', async () => {
    const { h, port } = makeRouter({ relays: [] });
    await h.start();

    const event = makePost('no socket');
    const res = await h.publish(event, ['p1']);

    expect(res.transport).toBe('mesh');
    expect(res.status).toBe('sent');
    expect(res.relayTried).toBe(false);
    expect(res.relayDetail).toBe('no open relay socket');
    expect(port.sent.length).toBeGreaterThan(0);
    await h.stop();
  });

  test('network not validated skips relay even with an open socket', async () => {
    const { h, port, sockets } = makeRouter({ networkValidated: () => false });
    await h.start();
    sockets[0].open();
    await tick();

    const event = makePost('offline signal');
    const res = await h.publish(event, ['p1']);

    expect(res.transport).toBe('mesh');
    expect(res.relayTried).toBe(false);
    expect(res.relayDetail).toBe('network not validated');
    expect(sentEvents(sockets[0])).toHaveLength(0); // no EVENT ever sent
    expect(port.sent.length).toBeGreaterThan(0);
    await h.stop();
  });

  test('no relay and no peers reports queued, not stored, local echo still fires', async () => {
    const { h, port } = makeRouter({ relays: [] });
    await h.start();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('nowhere to go');
    const res = await h.publish(event, []);

    expect(res.transport).toBe('none');
    expect(res.status).toBe('queued');
    expect(res.blePeers).toBe(0);
    expect(res.relays).toEqual([]);
    expect(port.sent).toHaveLength(0);
    expect(seen).toEqual(['local']);
    await h.stop();
  });

  test('dedup relay-then-mesh: mesh echo of a relay win is dropped', async () => {
    const { h, sockets } = makeRouter();
    await h.start();
    sockets[0].open();
    await tick();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('relay then mesh');
    const pending = h.publish(event, ['p1']);
    await tick();
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), true, '']);
    await pending;

    expect(h.ingress(event, 'ble', 'peer1')).toBe(false);
    expect(seen).toEqual(['local']); // no second insert
    await h.stop();
  });

  test('dedup mesh-then-relay: relay echo of a mesh win is dropped', async () => {
    const { h } = makeRouter({ relays: [] });
    await h.start();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('mesh then relay');
    await h.publish(event, ['p1']);

    expect(h.ingress(event, 'nostr')).toBe(false);
    expect(seen).toEqual(['local']);
    await h.stop();
  });

  test('relay win with peers present still sends nothing over BLE', async () => {
    const { h, port, sockets } = makeRouter();
    await h.start();
    sockets[0].open();
    await tick();

    const event = makePost('peers present relay wins');
    const pending = h.publish(event, ['p1', 'p2']);
    await tick();
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), true, '']);
    const res = await pending;

    expect(res.transport).toBe('relay');
    expect(port.sent).toHaveLength(0);
    await h.stop();
  });

  test('BLE echo of a mesh publish is deduped at hybrid ingress', async () => {
    const { h } = makeRouter({ relays: [] });
    await h.start();

    const seen: IngressSource[] = [];
    h.onPost((_e, source) => {
      seen.push(source);
    });

    const event = makePost('mesh echo');
    await h.publish(event, ['p1']);
    // The publish marked the id seen, so a BLE echo of the same event
    // is dropped at ingress, never re-emitted to handlers.
    expect(h.ingress(event, 'ble', 'p1')).toBe(false);
    expect(seen).toEqual(['local']);
    await h.stop();
  });
});

describe('NostrTransport.publishWithAck', () => {
  function makeNostr(relays: string[]) {
    const sockets: InjectableSocket[] = [];
    const nostr = new NostrTransport({
      relays,
      reconnectMs: 10,
      wsFactory: () => {
        const s = new InjectableSocket();
        sockets.push(s);
        return s;
      },
    });
    return { nostr, sockets };
  }

  test('accepted OK resolves with the relay URL', async () => {
    const { nostr, sockets } = makeNostr(['wss://mock.relay']);
    await nostr.start();
    sockets[0].open();
    await tick();

    const event = makePost('ack ok');
    const pending = nostr.publishWithAck(event, 500);
    await tick();
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), true, '']);
    const ack = await pending;

    expect(ack.ok).toEqual(['wss://mock.relay']);
    expect(ack.timedOut).toBe(false);
    await nostr.stop();
  });

  test('rejected OK resolves with no OK and no timeout', async () => {
    const { nostr, sockets } = makeNostr(['wss://mock.relay']);
    await nostr.start();
    sockets[0].open();
    await tick();

    const event = makePost('ack rejected');
    const pending = nostr.publishWithAck(event, 500);
    await tick();
    sockets[0].inject(['OK', sentEnvelopeId(sockets[0]), false, 'blocked']);
    const ack = await pending;

    expect(ack.ok).toEqual([]);
    expect(ack.rejected).toEqual(['wss://mock.relay']);
    expect(ack.timedOut).toBe(false);
    await nostr.stop();
  });

  test('no OK within the deadline resolves timedOut', async () => {
    const { nostr, sockets } = makeNostr(['wss://mock.relay']);
    await nostr.start();
    sockets[0].open();
    await tick();

    const event = makePost('ack timeout');
    const ack = await nostr.publishWithAck(event, 50);

    expect(ack.ok).toEqual([]);
    expect(ack.timedOut).toBe(true);
    await nostr.stop();
  });

  test('no open relay resolves immediately without waiting', async () => {
    const { nostr } = makeNostr([]);
    await nostr.start();

    const started = Date.now();
    const ack = await nostr.publishWithAck(makePost('no relay'), 5000);
    const elapsed = Date.now() - started;

    expect(ack.ok).toEqual([]);
    expect(ack.timedOut).toBe(false);
    expect(elapsed).toBeLessThan(1000);
    await nostr.stop();
  });

  test('socket close with no remaining relay resolves without timeout', async () => {
    const { nostr, sockets } = makeNostr(['wss://mock.relay']);
    await nostr.start();
    sockets[0].open();
    await tick();

    const event = makePost('socket drops');
    const pending = nostr.publishWithAck(event, 5000);
    await tick();
    sockets[0].close();
    const ack = await pending;

    expect(ack.ok).toEqual([]);
    expect(ack.timedOut).toBe(false);
    await nostr.stop();
  });

  test('stop resolves a pending publish as cancelled, not failed', async () => {
    const { nostr, sockets } = makeNostr(['wss://mock.relay']);
    await nostr.start();
    sockets[0].open();
    await tick();

    const pending = nostr.publishWithAck(makePost('cancelled by stop'), 5000);
    await tick();
    await nostr.stop();
    const ack = await pending;

    expect(ack.ok).toEqual([]);
    expect(ack.cancelled).toBe(true);
    expect(ack.timedOut).toBe(false);
  });
});
