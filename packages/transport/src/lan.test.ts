// SPDX-License-Identifier: Apache-2.0
// LanTransport tests (T15 Phase 1). The native NSD/TCP half is mocked
// via LanPort; the Android module is compiled by the CI build and
// proven on a real device, never by these tests.

import {
  encodeEvent,
  fragment,
  toHex,
  verifyEvent,
  NobleCrypto,
  DEFAULT_TTL,
  FRAG_WIRE_MAX,
  type SignedEvent,
} from '@airplane/protocol';
import { makePost, makeSizedEvent } from '../../protocol/src/test-helpers';
import { decodeEvent } from '@airplane/protocol';
import { LanTransport, LAN_FRAME_MAX, type LanPort } from './lan';

/** Minimal in-memory LanPort. */
class FakeLanPort implements LanPort {
  sent: { peerId: string; bytes: Uint8Array }[] = [];
  peers = new Set<string>();
  started = false;
  private receivers = new Set<(bytes: Uint8Array) => void>();

  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
  }
  discoveredPeerIds(): string[] {
    return [...this.peers];
  }
  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    this.sent.push({ peerId, bytes });
  }
  onReceive(cb: (bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }

  get receiverCount(): number {
    return this.receivers.size;
  }

  /** Simulate an inbound frame from the LAN. */
  inject(bytes: Uint8Array): void {
    for (const cb of this.receivers) cb(bytes);
  }
}

/** Inject a whole event as wire frames (what a real port delivers). */
function injectEvent(
  port: FakeLanPort,
  event: SignedEvent,
  opts?: { mtu?: number; shuffle?: boolean },
): void {
  const frames = fragment(encodeEvent(event), DEFAULT_TTL, opts?.mtu ?? FRAG_WIRE_MAX);
  const ordered = opts?.shuffle ? [...frames].reverse() : frames;
  for (const frame of ordered) port.inject(frame);
}

describe('LanTransport', () => {
  test('inbound wire frames reassemble and decode to one event, sender is the author', async () => {
    const port = new FakeLanPort();
    const lan = new LanTransport(port);
    await lan.start();

    const received: { event: SignedEvent; peerId: string }[] = [];
    lan.onReceive((event, peerId) => {
      received.push({ event, peerId });
    });

    const event = makePost('lan hello');
    injectEvent(port, event);

    expect(received).toHaveLength(1);
    expect(toHex(received[0].event.id)).toBe(toHex(event.id));
    expect(received[0].peerId).toBe(toHex(event.pubkey));
    await lan.stop();
  });

  test('verify: a valid signed event passes, tampered events are dropped', async () => {
    const port = new FakeLanPort();
    const crypto = new NobleCrypto();
    const lan = new LanTransport(port, {
      verify: (event) => verifyEvent(crypto, event),
    });
    await lan.start();
    const received: SignedEvent[] = [];
    lan.onReceive((e) => {
      received.push(e);
    });

    injectEvent(port, makePost('genuine'));
    expect(received).toHaveLength(1);

    const genuine = makePost('victim');
    const badSig = new Uint8Array(genuine.sig);
    badSig[0] ^= 1;
    injectEvent(port, { ...genuine, sig: badSig });
    expect(received).toHaveLength(1); // flipped signature: dropped

    injectEvent(port, { ...makePost('other'), content: 'tampered' });
    expect(received).toHaveLength(1); // content/id mismatch: dropped
    await lan.stop();
  });

  test('verify: a throwing verifier drops the event without breaking the transport', async () => {
    const port = new FakeLanPort();
    const lan = new LanTransport(port, {
      verify: () => {
        throw new Error('verifier blew up');
      },
    });
    await lan.start();
    const received: SignedEvent[] = [];
    lan.onReceive((e) => {
      received.push(e);
    });
    injectEvent(port, makePost('hello'));
    expect(received).toHaveLength(0);
    await lan.stop(); // still stops cleanly
  });

  test('fragments arriving out of order still reassemble', async () => {
    const port = new FakeLanPort();
    const lan = new LanTransport(port);
    await lan.start();

    const received: SignedEvent[] = [];
    lan.onReceive((e) => {
      received.push(e);
    });

    const event = decodeEvent(makeSizedEvent(2000));
    injectEvent(port, event, { shuffle: true });

    expect(received).toHaveLength(1);
    expect(toHex(received[0].id)).toBe(toHex(event.id));
    await lan.stop();
  });

  test('duplicate inbound event is suppressed and the dedup hook fires', async () => {
    const port = new FakeLanPort();
    const dropped: string[] = [];
    const lan = new LanTransport(port, {
      onDedupDrop: (peerId) => {
        dropped.push(peerId);
      },
    });
    await lan.start();

    let count = 0;
    lan.onReceive(() => {
      count++;
    });

    const event = makePost('dup');
    injectEvent(port, event);
    injectEvent(port, event);
    expect(count).toBe(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toBe(toHex(event.pubkey));
    await lan.stop();
  });

  test('broadcast encodes and sends one frame per peer at the LAN frame size', async () => {
    const port = new FakeLanPort();
    const lan = new LanTransport(port);
    await lan.start();

    const event = makePost('broadcast me');
    const sent = await lan.broadcast(event, ['p1', 'p2']);
    expect(sent).toBe(2);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[0].peerId).toBe('p1');
    for (const { bytes } of port.sent) {
      expect(bytes.length).toBeLessThanOrEqual(LAN_FRAME_MAX);
    }

    // Our own broadcast must not echo back as "new".
    let count = 0;
    lan.onReceive(() => {
      count++;
    });
    port.inject(port.sent[0].bytes);
    expect(count).toBe(0);
    await lan.stop();
  });

  test('broadcast fragments large events to the port frame size and counts only successes', async () => {
    class SmallFramePort extends FakeLanPort {
      frameSizeFor(): number {
        return 64;
      }
    }
    const port = new SmallFramePort();
    const origSend = port.send.bind(port);
    port.send = async (peerId: string, bytes: Uint8Array) => {
      if (peerId === 'bad') throw new Error('peer left the LAN');
      return origSend(peerId, bytes);
    };
    const lan = new LanTransport(port);
    await lan.start();

    const event = decodeEvent(makeSizedEvent(2000));
    const sent = await lan.broadcast(event, ['bad', 'good']);
    expect(sent).toBe(1);
    expect(port.sent.length).toBeGreaterThan(1);
    for (const { bytes } of port.sent) {
      expect(bytes.length).toBeLessThanOrEqual(64);
    }

    // A remote LanTransport fed those exact frames reassembles the event.
    const remotePort = new FakeLanPort();
    const remote = new LanTransport(remotePort);
    await remote.start();
    const got: SignedEvent[] = [];
    remote.onReceive((e) => got.push(e));
    for (const { bytes } of port.sent) remotePort.inject(bytes);
    expect(got).toHaveLength(1);
    expect(toHex(got[0].id)).toBe(toHex(event.id));
    await lan.stop();
    await remote.stop();
  });

  test('start is idempotent, stop unsubscribes, and a failing native start stays inert', async () => {
    const port = new FakeLanPort();
    const lan = new LanTransport(port);
    await lan.start();
    await lan.start(); // second start is a no-op
    expect(port.receiverCount).toBe(1);
    await lan.stop();
    await lan.stop(); // second stop is safe
    expect(port.receiverCount).toBe(0);

    class FailingPort extends FakeLanPort {
      async start(): Promise<void> {
        throw new Error('no native module');
      }
    }
    const failing = new LanTransport(new FailingPort());
    await expect(failing.start()).resolves.toBeUndefined();
    expect(failing.discoveredPeerIds()).toEqual([]);
    await failing.stop();
  });

  test('discoveredPeerIds delegates to the port', async () => {
    const port = new FakeLanPort();
    port.peers.add('peer-a');
    port.peers.add('peer-b');
    const lan = new LanTransport(port);
    expect(lan.discoveredPeerIds().sort()).toEqual(['peer-a', 'peer-b']);
  });
});
