// SPDX-License-Identifier: Apache-2.0
// DmBleTransport tests: flagged DM frames over a loopback port pair, ack
// routing, feed-channel isolation, session dedup, and the 4 KiB DM size.

import { ed25519 } from '@noble/curves/ed25519.js';
import type { TransportPort } from '@airplane/protocol';
import { dmToHex, sealDm, type DmEnvelope } from './dm';
import { DmBleTransport } from './dmBle';
import { BleTransport } from './hybrid';

/** Loopback BLE port: send() delivers frames to the linked peer's receivers. */
class FakePort implements TransportPort {
  receivers = new Set<(peerId: string, bytes: Uint8Array) => void>();
  peer: FakePort | null = null;
  sent: Uint8Array[] = [];
  peers: string[] = ['peer-a'];

  async advertise(): Promise<void> {}
  async stopAdvertise(): Promise<void> {}
  async scan(): Promise<() => void> {
    return () => {};
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_peerId: string, bytes: Uint8Array): Promise<void> {
    this.sent.push(bytes);
    if (this.peer) {
      for (const cb of [...this.peer.receivers]) cb('peer-a', bytes);
    }
  }
  frameSizeFor(): number {
    return 469;
  }
  connectedPeerIds(): string[] {
    return [...this.peers];
  }
  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }
}

function link(): { portA: FakePort; portB: FakePort; dmA: DmBleTransport; dmB: DmBleTransport } {
  const portA = new FakePort();
  const portB = new FakePort();
  portA.peer = portB;
  portB.peer = portA;
  return { portA, portB, dmA: new DmBleTransport(portA), dmB: new DmBleTransport(portB) };
}

describe('DmBleTransport', () => {
  test('a DM envelope crosses the loopback and arrives intact, sealed', () => {
    const { dmA, dmB } = link();
    const received: DmEnvelope[] = [];
    const acks: DmEnvelope[] = [];
    dmB.subscribe(
      e => {
        received.push(e);
      },
      e => {
        acks.push(e);
      },
    );
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const envelope = sealDm('ble hello', dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    return dmA.publish(envelope, 'dm').then(count => {
      expect(count).toBe(1);
      expect(received).toHaveLength(1);
      expect(received[0].sealed).toBe(envelope.sealed);
      expect(received[0].sealed).not.toContain('ble hello');
      expect(acks).toHaveLength(0);
    });
  });

  test('ack frames route to the ack callback only, never the message callback', async () => {
    const { dmA, dmB } = link();
    const received: DmEnvelope[] = [];
    const acks: DmEnvelope[] = [];
    dmB.subscribe(
      e => {
        received.push(e);
      },
      e => {
        acks.push(e);
      },
    );
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const ackEnvelope = sealDm('{"dmAckFor":"00"}', dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    await dmA.publish(ackEnvelope, 'ack');
    expect(acks).toHaveLength(1);
    expect(received).toHaveLength(0);
  });

  test('a duplicate delivery id on the same link is dropped', async () => {
    const { dmA, dmB } = link();
    const received: DmEnvelope[] = [];
    dmB.subscribe(
      e => {
        received.push(e);
      },
      () => {},
    );
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const envelope = sealDm('twice', dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    await dmA.publish(envelope, 'dm');
    await dmA.publish(envelope, 'dm');
    expect(received).toHaveLength(1);
  });

  test('a 4 KiB DM reassembles over the loopback (past the feed 4 KiB cap)', async () => {
    const { dmA, dmB } = link();
    const received: DmEnvelope[] = [];
    dmB.subscribe(
      e => {
        received.push(e);
      },
      () => {},
    );
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const envelope = sealDm('x'.repeat(4000), dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    const count = await dmA.publish(envelope, 'dm');
    expect(count).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].sealed).toBe(envelope.sealed);
  });

  test('publish with no connected peers returns 0 (queued, never claimed)', async () => {
    const port = new FakePort();
    port.peers = [];
    const dm = new DmBleTransport(port);
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const envelope = sealDm('nowhere', dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    await expect(dm.publish(envelope, 'dm')).resolves.toBe(0);
  });

  test('the feed transport ignores DM-channel frames (no handler call, no crash)', async () => {
    const port = new FakePort();
    port.peer = port; // self-loopback: DM frames reach the feed listener on this port
    const feed = new BleTransport(port);
    const seen: unknown[] = [];
    feed.onReceive((event: unknown) => {
      seen.push(event);
    });
    await feed.start();
    const dm = new DmBleTransport(port);
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const envelope = sealDm('not feed', dmToHex(ed25519.getPublicKey(sender)), dmToHex(ed25519.getPublicKey(recipient)));
    // DM frames flow through the same port receivers the feed transport
    // listens on: the feed reassembler must ignore them, not decode them.
    await dm.publish(envelope, 'dm');
    expect(seen).toHaveLength(0);
    await feed.stop();
  });
});
