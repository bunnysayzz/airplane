// SPDX-License-Identifier: Apache-2.0
// DM transport fixes, 2026-11-03 branch: rank 1 Relayed re-publish,
// rank 8 terminal head-of-line skip, rank 9 lost-ack resend on start.
// No em dashes or en dashes in this file, per repo style for this branch.

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  DM_RELAYED_ACK_WINDOW_MS,
  DM_RELAYED_MAX_REPUBLISH,
  DM_RELAYED_UNREACHABLE_RETRY_MS,
  DmService,
  MemoryDmStore,
  type DmMeshPort,
  type DmRelayPort,
  type DmRelayPublishResult,
} from './dmService';
import { dmKeypairFromDeviceSecret, dmToHex, sealDm, type DmEnvelope } from './dm';

const tick = () => new Promise<void>(r => setTimeout(r, 10));

interface Persona {
  secret: Uint8Array;
  meshHex: string;
  service: DmService;
  store: MemoryDmStore;
}

function makePersona(
  relay: DmRelayPort,
  nowRef: { now: number },
  mesh?: DmMeshPort,
): Persona {
  const secret = ed25519.utils.randomSecretKey();
  const meshHex = dmToHex(ed25519.getPublicKey(secret));
  const store = new MemoryDmStore();
  const service = new DmService({
    store,
    relay,
    mesh,
    ownKeys: () => dmKeypairFromDeviceSecret(secret),
    ownMeshHex: () => meshHex,
    now: () => nowRef.now,
  });
  return { secret, meshHex, service, store };
}

/** Relay with a mode switch, for window and cap tests. */
class ModeRelay implements DmRelayPort {
  mode: 'accept' | 'reject' | 'unreachable' = 'accept';
  publishCalls = 0;
  async publish(): Promise<DmRelayPublishResult> {
    this.publishCalls += 1;
    if (this.mode === 'accept') return { accepted: true, rejected: false };
    if (this.mode === 'reject') return { accepted: false, rejected: true };
    return { accepted: false, rejected: false };
  }
  async publishAck(): Promise<DmRelayPublishResult> {
    return { accepted: false, rejected: false };
  }
  subscribe(): () => void {
    return () => {};
  }
}

/** Relay that always explicitly rejects, for the head-of-line test. */
class RejectingRelay implements DmRelayPort {
  async publish(): Promise<DmRelayPublishResult> {
    return { accepted: false, rejected: true };
  }
  async publishAck(): Promise<DmRelayPublishResult> {
    return { accepted: false, rejected: false };
  }
  subscribe(): () => void {
    return () => {};
  }
}

/**
 * In-process relay for the ack test: message delivery always works,
 * ack delivery follows ackAccept, and ack publish calls are counted.
 */
class AckToggleRelay implements DmRelayPort {
  ackAccept = false;
  ackPublishCalls = 0;
  private readonly subs = new Set<{
    ownHex: string;
    cb: (e: DmEnvelope) => void;
    ackCb?: (e: DmEnvelope) => void;
  }>();

  async publish(envelope: DmEnvelope): Promise<DmRelayPublishResult> {
    for (const s of [...this.subs]) {
      if (s.ownHex === envelope.recipientHex) s.cb(envelope);
    }
    return { accepted: true, rejected: false };
  }

  async publishAck(envelope: DmEnvelope): Promise<DmRelayPublishResult> {
    this.ackPublishCalls += 1;
    if (!this.ackAccept) return { accepted: false, rejected: false };
    for (const s of [...this.subs]) {
      if (s.ownHex === envelope.recipientHex && s.ackCb) s.ackCb(envelope);
    }
    return { accepted: true, rejected: false };
  }

  subscribe(
    ownMeshHex: string,
    onEnvelope: (e: DmEnvelope) => void,
    onAck?: (e: DmEnvelope) => void,
  ): () => void {
    const entry = { ownHex: ownMeshHex, cb: onEnvelope, ackCb: onAck };
    this.subs.add(entry);
    return () => {
      this.subs.delete(entry);
    };
  }
}

describe('rank 1: Relayed re-publish', () => {
  test('no re-publish inside the window, even on a forced flush; re-publish after the window, capped, label stays Relayed', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 200_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'a'.repeat(64);
    await alice.service.sendMessage(peer, 'window test');
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(rows[0].relayRepublishAttempts).toBe(0);
    expect(relay.publishCalls).toBe(1);
    // Inside the window, even a forced flush must not re-publish.
    nowRef.now += 60 * 60 * 1000;
    await alice.service.flushOutbox(true);
    expect(relay.publishCalls).toBe(1);
    // Past the window, each re-publish waits a fresh window, until cap.
    for (let i = 1; i <= DM_RELAYED_MAX_REPUBLISH; i += 1) {
      nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
      await alice.service.flushOutbox();
      expect(relay.publishCalls).toBe(1 + i);
      rows = await alice.store.listMessages(peer);
      expect(rows[0].status).toBe('Relayed');
      expect(rows[0].relayRepublishAttempts).toBe(i);
    }
    // Past the cap, no more re-publishes: gap 105 turns the capped
    // Relayed row Failed on the next flush, mirroring MeshSent.
    nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
    await alice.service.flushOutbox(true);
    expect(relay.publishCalls).toBe(1 + DM_RELAYED_MAX_REPUBLISH);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    alice.service.stop();
  });

  test('an unreachable relay does not burn the re-publish cap', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 300_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'unreachable test');
    await alice.service.flushOutbox();
    expect(relay.publishCalls).toBe(1);
    relay.mode = 'unreachable';
    nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(rows[0].relayRepublishAttempts).toBe(0);
    // The unreachable retry is due soon, not after another full window.
    expect(rows[0].nextAttemptAtMs).toBe(nowRef.now + DM_RELAYED_UNREACHABLE_RETRY_MS);
    nowRef.now += DM_RELAYED_UNREACHABLE_RETRY_MS + 1;
    relay.mode = 'accept';
    await alice.service.flushOutbox();
    rows = await alice.store.listMessages(peer);
    expect(rows[0].relayRepublishAttempts).toBe(1);
    expect(relay.publishCalls).toBe(3);
    alice.service.stop();
  });

  test('a re-published identical envelope does not inflate unread counts', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 400_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    await alice.service.sendMessage(bob.meshHex, 'dedup test');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(bob.meshHex);
    const envelope = rows[0].envelope;
    expect(envelope).toBeDefined();
    // The recipient stores it once, then sees the identical envelope
    // again (the re-publish): one row, one unread increment.
    expect(await bob.service.receiveEnvelope(envelope as DmEnvelope)).toBe('request');
    expect(await bob.service.receiveEnvelope(envelope as DmEnvelope)).toBe('ignored');
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    const requests = await bob.service.listRequests();
    expect(requests[0].unread).toBe(1);
    alice.service.stop();
    bob.service.stop();
  });
});

describe('rank 8: terminal head-of-line', () => {
  test('a row that turns Failed inside a flush does not block a later row in the same flush', async () => {
    const relay = new RejectingRelay();
    const nowRef = { now: 500_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'c'.repeat(64);
    await alice.service.sendMessage(peer, 'head row');
    await alice.service.sendMessage(peer, 'later row');
    // Seed the head row one attempt below the cap, so one flush turns
    // it Failed. The later row must still be attempted in that flush.
    let rows = await alice.store.listMessages(peer);
    rows[0].attempts = 4;
    await alice.store.updateMessage(rows[0]);
    await alice.service.flushOutbox();
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    expect(rows[1].attempts).toBe(1);
    expect(rows[1].status).toBe('Sending');
    alice.service.stop();
  });
});

describe('rank 9: lost-ack resend on start', () => {
  test('an ack that never left is re-sent on a restarted service and upgrades the sender, including from Failed', async () => {
    const relay = new AckToggleRelay();
    relay.ackAccept = false;
    const nowRef = { now: 600_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'ack me');
    await alice.service.flushOutbox();
    await tick();
    // Bob stored the message, but its ack never left (relay refused
    // acks), so Alice stays Relayed and Bob has a pending ack.
    let aliceRows = await alice.store.listMessages(bob.meshHex);
    expect(aliceRows[0].status).toBe('Relayed');
    let bobRows = await bob.store.listMessages(alice.meshHex);
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0].ackSent).not.toBe(true);
    // Acks now work. Restarting Bob (service start) re-sends the ack,
    // and Alice upgrades to Delivered without a new message.
    relay.ackAccept = true;
    bob.service.stop();
    const bobRestarted = new DmService({
      store: bob.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(bob.secret),
      ownMeshHex: () => bob.meshHex,
      now: () => nowRef.now,
    });
    bobRestarted.start();
    await tick();
    aliceRows = await alice.store.listMessages(bob.meshHex);
    expect(aliceRows[0].status).toBe('Delivered');
    bobRows = await bob.store.listMessages(alice.meshHex);
    expect(bobRows[0].ackSent).toBe(true);
    // A second resend sends nothing new: the ack already left.
    const callsBefore = relay.ackPublishCalls;
    await bobRestarted.resendPendingAcks();
    expect(relay.ackPublishCalls).toBe(callsBefore);
    alice.service.stop();
    bobRestarted.stop();
  });

  test('resend skips blocked conversations', async () => {
    const relay = new AckToggleRelay();
    relay.ackAccept = false;
    const nowRef = { now: 700_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const envelope = sealDm('blocked ack', alice.meshHex, bob.meshHex);
    expect(await bob.service.receiveEnvelope(envelope)).toBe('request');
    await tick();
    await bob.service.blockPeer(alice.meshHex);
    relay.ackAccept = true;
    const callsBefore = relay.ackPublishCalls;
    await bob.service.resendPendingAcks();
    // No ack is re-sent to a blocked peer, even though acks now work.
    expect(relay.ackPublishCalls).toBe(callsBefore);
    alice.service.stop();
    bob.service.stop();
  });
});

describe('gap 105: capped Relayed rows become Failed', () => {
  test('tap-to-retry works on a capped Relayed row', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 800_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'd'.repeat(64);
    await alice.service.sendMessage(peer, 'retry me');
    await alice.service.flushOutbox();
    for (let i = 1; i <= DM_RELAYED_MAX_REPUBLISH; i += 1) {
      nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
      await alice.service.flushOutbox();
    }
    nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    // Tap-to-retry re-queues, and the next flush sends again.
    await alice.service.retryMessage(peer, rows[0].id);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Sending');
    await alice.service.flushOutbox();
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    alice.service.stop();
  });

  test('a capped Relayed row turning Failed does not block a later row', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 900_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'e'.repeat(64);
    await alice.service.sendMessage(peer, 'head row');
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    rows[0].relayRepublishAttempts = DM_RELAYED_MAX_REPUBLISH;
    await alice.store.updateMessage(rows[0]);
    await alice.service.sendMessage(peer, 'later row');
    await alice.service.flushOutbox();
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    expect(rows[1].status).toBe('Relayed');
    expect(relay.publishCalls).toBe(2);
    alice.service.stop();
  });

  test('a late ack still upgrades a capped-then-Failed row to Delivered', async () => {
    const relay = new AckToggleRelay();
    relay.ackAccept = false;
    const nowRef = { now: 1_000_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'cap then ack');
    await alice.service.flushOutbox();
    await tick();
    let aliceRows = await alice.store.listMessages(bob.meshHex);
    expect(aliceRows[0].status).toBe('Relayed');
    for (let i = 1; i <= DM_RELAYED_MAX_REPUBLISH; i += 1) {
      nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
      await alice.service.flushOutbox();
    }
    nowRef.now += DM_RELAYED_ACK_WINDOW_MS + 1;
    await alice.service.flushOutbox();
    aliceRows = await alice.store.listMessages(bob.meshHex);
    expect(aliceRows[0].status).toBe('Failed');
    // Acks now work. Restarting Bob re-sends the pending ack, and the
    // Failed row upgrades to Delivered without a new message.
    relay.ackAccept = true;
    bob.service.stop();
    const bobRestarted = new DmService({
      store: bob.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(bob.secret),
      ownMeshHex: () => bob.meshHex,
      now: () => nowRef.now,
    });
    bobRestarted.start();
    await tick();
    aliceRows = await alice.store.listMessages(bob.meshHex);
    expect(aliceRows[0].status).toBe('Delivered');
    alice.service.stop();
    bobRestarted.stop();
  });
});

describe('gap 106: DM relay win also sends over Bluetooth', () => {
  /** Counting BLE mesh port for DM tests. */
  class CountingMesh implements DmMeshPort {
    calls = 0;
    throwOnPublish = false;
    peers = 1;
    async publish(): Promise<number> {
      this.calls += 1;
      if (this.throwOnPublish) throw new Error('ble down');
      return this.peers;
    }
    subscribe(): () => void {
      return () => {};
    }
  }

  test('relay win plus connected peers calls mesh publish and stays Relayed', async () => {
    const relay = new ModeRelay();
    const mesh = new CountingMesh();
    const nowRef = { now: 1_100_000_000 };
    const alice = makePersona(relay, nowRef, mesh);
    const peer = 'f'.repeat(64);
    await alice.service.sendMessage(peer, 'relay plus ble');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(mesh.calls).toBe(1);
    expect(rows[0].meshAttempts).toBe(0);
    alice.service.stop();
  });

  test('relay win with no mesh port still lands Relayed', async () => {
    const relay = new ModeRelay();
    const nowRef = { now: 1_200_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'a'.repeat(64);
    await alice.service.sendMessage(peer, 'relay only');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    alice.service.stop();
  });

  test('a throwing mesh leg leaves the relay result unchanged', async () => {
    const relay = new ModeRelay();
    const mesh = new CountingMesh();
    mesh.throwOnPublish = true;
    const nowRef = { now: 1_300_000_000 };
    const alice = makePersona(relay, nowRef, mesh);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'ble throws');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(mesh.calls).toBe(1);
    alice.service.stop();
  });

  test('a mesh leg reaching zero peers still lands Relayed', async () => {
    const relay = new ModeRelay();
    const mesh = new CountingMesh();
    mesh.peers = 0;
    const nowRef = { now: 1_400_000_000 };
    const alice = makePersona(relay, nowRef, mesh);
    const peer = 'c'.repeat(64);
    await alice.service.sendMessage(peer, 'no peers');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(mesh.calls).toBe(1);
    alice.service.stop();
  });
});
