// SPDX-License-Identifier: Apache-2.0
// DM P1 tests: sealed round-trip, requests routing, block silent-drop,
// delete-local-only, outbox retry -> Failed after cap, per-conversation FIFO.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  DM_MAX_ATTEMPTS,
  chacha20,
  dmAckProofForEnvelope,
  dmConversationKey,
  dmConversationKeyX,
  dmKeypairFromDeviceSecret,
  dmToHex,
  meshPubkeyToX25519,
  nip44Decrypt,
  nip44Encrypt,
  sealDm,
  sealDmWithAckProof,
  unsealDm,
} from './dm';
import {
  DmService,
  FailingDmRelay,
  MemoryDmRelay,
  MemoryDmStore,
  type DmEvent,
  type DmMeshPort,
  type DmRelayPort,
  type DmRelayPublishResult,
} from './dmService';

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
  extra?: { nextDmSeq?: () => Promise<number | null>; onDmEvent?: (e: DmEvent) => void },
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
    nextDmSeq: extra?.nextDmSeq,
    onDmEvent: extra?.onDmEvent,
  });
  return { secret, meshHex, service, store };
}

/** Relay whose acceptance flips, for queue-drain tests. */
class TogglingRelay implements DmRelayPort {
  accept = false;
  async publish(): Promise<DmRelayPublishResult> {
    return { accepted: this.accept, rejected: false };
  }
  async publishAck(): Promise<DmRelayPublishResult> {
    return { accepted: false, rejected: false };
  }
  subscribe(): () => void {
    return () => {};
  }
}

/** Relay that explicitly rejects every envelope (relay policy, not offline). */
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

/** Loopback mesh endpoint pair for BLE-path tests (direct peers only). */
class LoopMesh implements DmMeshPort {
  peer: LoopMesh | null = null;
  private onEnv: ((e: import('./dm').DmEnvelope) => void) | null = null;
  private onAck: ((e: import('./dm').DmEnvelope) => void) | null = null;
  async publish(envelope: import('./dm').DmEnvelope, kind: 'dm' | 'ack'): Promise<number> {
    if (!this.peer) return 0;
    if (kind === 'dm') this.peer.onEnv?.(envelope);
    else this.peer.onAck?.(envelope);
    return 1;
  }
  subscribe(
    onEnvelope: (e: import('./dm').DmEnvelope) => void,
    onAck: (e: import('./dm').DmEnvelope) => void,
  ): () => void {
    this.onEnv = onEnvelope;
    this.onAck = onAck;
    return () => {
      this.onEnv = null;
      this.onAck = null;
    };
  }
}

describe('DM crypto', () => {
  test('Ed25519 -> X25519 conversion is consistent with the derived keypair', () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(secret);
    const dm = dmKeypairFromDeviceSecret(secret);
    expect(dmToHex(dm.publicKey)).toBe(dmToHex(meshPubkeyToX25519(pub)));
  });

  test('conversation keys are symmetric across the pair', () => {
    const a = ed25519.utils.randomSecretKey();
    const b = ed25519.utils.randomSecretKey();
    const ka = dmConversationKey(dmKeypairFromDeviceSecret(a).secretKey, ed25519.getPublicKey(b));
    const kb = dmConversationKey(dmKeypairFromDeviceSecret(b).secretKey, ed25519.getPublicKey(a));
    expect(ka).toEqual(kb);
  });

  test('chacha20 matches node crypto (RFC 8439 construction)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto') as typeof import('crypto');
    const key = Buffer.alloc(32, 7);
    const nonce12 = Buffer.alloc(12, 3);
    const data = Buffer.from('hello dm world, this is a chacha check over 64 bytes..................');
    const nonce16 = Buffer.concat([Buffer.alloc(4, 0), nonce12]);
    const cipher = nodeCrypto.createCipheriv('chacha20', key, nonce16);
    const expected = Buffer.concat([cipher.update(data), cipher.final()]);
    const got = chacha20(new Uint8Array(key), new Uint8Array(nonce12), new Uint8Array(data));
    expect(Buffer.from(got)).toEqual(expected);
  });

  test('NIP-44-style round-trip; tamper and wrong key give null, never text', () => {
    const key = new Uint8Array(32).fill(9);
    const payload = nip44Encrypt('secret hello', key);
    expect(nip44Decrypt(payload, key)).toBe('secret hello');
    const wrongKey = new Uint8Array(32).fill(8);
    expect(nip44Decrypt(payload, wrongKey)).toBeNull();
    // Flip one ciphertext byte (middle of the payload) -> MAC failure.
    const raw = Buffer.from(payload, 'base64');
    raw[40] ^= 0x01;
    expect(nip44Decrypt(raw.toString('base64'), key)).toBeNull();
    expect(nip44Decrypt('not-base64!!', key)).toBeNull();
  });

  test('F19: sealDm throws on a malformed sender hex', () => {
    const bob = ed25519.utils.randomSecretKey();
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    expect(() => sealDm('hi', 'not-hex', bobHex)).toThrow('sealDm: bad sender pubkey');
    expect(() => sealDm('hi', 'a'.repeat(63), bobHex)).toThrow('sealDm: bad sender pubkey');
  });

  test('F18: sealDm lowercases sender and recipient hex', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const envelope = sealDm('cased', aliceHex.toUpperCase(), bobHex.toUpperCase());
    expect(envelope.recipientHex).toBe(bobHex);
    const rumor = unsealDm(envelope, dmKeypairFromDeviceSecret(bob), bobHex);
    expect(rumor?.pubkey).toBe(aliceHex);
    expect(rumor?.tags).toEqual([['p', bobHex]]);
  });

  test('F11: unseal rejects oversize content, mistagged rumors, and rumors without a p tag', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const bobKeys = dmKeypairFromDeviceSecret(bob);
    // Oversize content: sealed fine, rejected on ingress.
    const big = sealDm('x'.repeat(5000), aliceHex, bobHex);
    expect(unsealDm(big, bobKeys)).toBeNull();
    // Correct p tag passes, wrong expected recipient fails.
    const ok = sealDm('fine', aliceHex, bobHex);
    expect(unsealDm(ok, bobKeys, bobHex)?.content).toBe('fine');
    expect(unsealDm(ok, bobKeys, 'a'.repeat(64))).toBeNull();
    // A rumor with no p tag at all fails when a recipient is expected.
    const ephemeralSecret = x25519.utils.randomSecretKey();
    const ephemeralPubkey = x25519.getPublicKey(ephemeralSecret);
    const convKey = dmConversationKeyX(ephemeralSecret, meshPubkeyToX25519(ed25519.getPublicKey(bob)));
    const noTag = {
      ephemeralPubkeyHex: dmToHex(ephemeralPubkey),
      recipientHex: bobHex,
      sealed: nip44Encrypt(
        JSON.stringify({ kind: 14, pubkey: aliceHex, created_at: 1000, tags: [], content: 'no tag' }),
        convKey,
      ),
      createdAt: 1000,
    };
    expect(unsealDm(noTag, bobKeys, bobHex)).toBeNull();
  });

  test('sealed round-trip: recipient reads it, relay view and third party get gibberish', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const carol = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const envelope = sealDm('meet at dawn', aliceHex, bobHex);
    // Relay view: the sealed payload never contains the plaintext.
    expect(envelope.sealed).not.toContain('meet at dawn');
    expect(envelope.recipientHex).toBe(bobHex);
    const rumor = unsealDm(envelope, dmKeypairFromDeviceSecret(bob));
    expect(rumor?.content).toBe('meet at dawn');
    expect(rumor?.pubkey).toBe(aliceHex);
    expect(unsealDm(envelope, dmKeypairFromDeviceSecret(carol))).toBeNull();
    expect(unsealDm(envelope, dmKeypairFromDeviceSecret(alice))).toBeNull();
    // Tampered sealed bytes -> null for everyone, including the recipient.
    const tampered = { ...envelope, sealed: envelope.sealed.slice(0, -4) + 'AAAA' };
    expect(unsealDm(tampered, dmKeypairFromDeviceSecret(bob))).toBeNull();
  });
});

describe('DmService routing + outbox', () => {
  test('unknown sender lands in requests, never inbox; Accept moves it to inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 1_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'hi bob, saw your post');
    await alice.service.flushOutbox();
    await tick();
    expect(await bob.service.listInbox()).toEqual([]);
    const requests = await bob.service.listRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].peerHex).toBe(alice.meshHex);
    expect(requests[0].unread).toBe(1);
    // Thread decrypts on read; last-message preview would use the same path.
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    expect(thread[0].text).toBe('hi bob, saw your post');
    await bob.service.acceptRequest(alice.meshHex);
    expect((await bob.service.listInbox()).map(c => c.peerHex)).toContain(alice.meshHex);
    expect(await bob.service.listRequests()).toEqual([]);
    await bob.service.markRead(alice.meshHex);
    expect(await bob.service.totalUnread()).toBe(0);
  });

  test('Ignore hides the request; the peer writing again re-surfaces it in requests', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 2_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.receiveEnvelope(sealDm('first', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
    await bob.service.ignoreRequest(alice.meshHex);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.listInbox()).toEqual([]);
    await bob.service.receiveEnvelope(sealDm('second', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
  });

  test('block = silent drop of future messages (no row, no badge, no inbox)', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 3_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.blockPeer(alice.meshHex);
    const verdict = await bob.service.receiveEnvelope(sealDm('spam?', alice.meshHex, bob.meshHex));
    expect(verdict).toBe('dropped');
    expect(await bob.service.listInbox()).toEqual([]);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.getThread(alice.meshHex)).toEqual([]);
    expect(await bob.service.totalUnread()).toBe(0);
    await bob.service.unblockPeer(alice.meshHex);
    await bob.service.receiveEnvelope(sealDm('hello again', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
  });

  test('mute: messages arrive but the badge does not move', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 4_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.receiveEnvelope(sealDm('yo', alice.meshHex, bob.meshHex));
    await bob.service.acceptRequest(alice.meshHex);
    await bob.service.markRead(alice.meshHex);
    await bob.service.mutePeer(alice.meshHex, true);
    await bob.service.receiveEnvelope(sealDm('yo again', alice.meshHex, bob.meshHex));
    expect((await bob.service.getThread(alice.meshHex)).length).toBe(2);
    expect(await bob.service.totalUnread()).toBe(0);
  });

  test('delete is local only: sender store emptied, recipient copy intact', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 5_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'will delete this');
    await alice.service.flushOutbox();
    await tick();
    expect((await bob.service.getThread(alice.meshHex)).length).toBe(1);
    await bob.service.deleteConversationLocalOnly(alice.meshHex);
    expect(await bob.service.listInbox()).toEqual([]);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.getThread(alice.meshHex)).toEqual([]);
    expect(await bob.store.getConversation(alice.meshHex)).toBeNull();
    // Recipient-side deletion changed nothing on the sender's device.
    expect((await alice.service.getThread(bob.meshHex)).length).toBe(1);
  });

  test('outbox with no transport ends in Queued, never Failed, and is not dropped', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 10_000_000 };
    const alice = makePersona(relay, nowRef);
    await alice.service.sendMessage('b'.repeat(64), 'offline msg');
    // Attempt 1 at t, then backoffs 1s / 5s / 30s / 120s, then repeats at
    // the 120 s cap: unreachable transports never end in Failed, so a
    // long offline stretch still drains when a transport returns.
    const steps = [0, 1000, 5000, 30000, 120000, 120000, 120000];
    for (const step of steps) {
      nowRef.now += step;
      await alice.service.flushOutbox();
    }
    const thread = await alice.service.getThread('b'.repeat(64));
    expect(thread).toHaveLength(1);
    expect(thread[0].status).toBe('Queued');
    expect(DM_MAX_ATTEMPTS).toBe(5);
  });

  test('outbox with explicit relay rejection ends in Failed after the cap, with tap-to-retry', async () => {
    const relay = new RejectingRelay();
    const nowRef = { now: 11_000_000 };
    const alice = makePersona(relay, nowRef);
    await alice.service.sendMessage('b'.repeat(64), 'rejected msg');
    // Attempt 1 at t, then backoffs 1s / 5s / 30s / 120s -> 5 attempts total.
    const steps = [0, 1000, 5000, 30000, 120000];
    for (const step of steps) {
      nowRef.now += step;
      await alice.service.flushOutbox();
    }
    const thread = await alice.service.getThread('b'.repeat(64));
    expect(thread).toHaveLength(1);
    expect(thread[0].status).toBe('Failed');
    // Tap-to-retry re-queues it (still failing here, but back to Sending).
    await alice.service.retryMessage('b'.repeat(64), thread[0].id);
    const retried = await alice.service.getThread('b'.repeat(64));
    expect(retried[0].status).toBe('Sending');
  });

  test('per-conversation FIFO: a failed head blocks its conversation only', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 20_000_000 };
    const alice = makePersona(relay, nowRef);
    const peerA = 'a'.repeat(64);
    const peerB = 'c'.repeat(64);
    await alice.service.sendMessage(peerA, 'a-first');
    await alice.service.sendMessage(peerA, 'a-second');
    await alice.service.sendMessage(peerB, 'b-only');
    await alice.service.flushOutbox();
    // All three failed once; FIFO means a-second was never attempted while
    // a-first was the failing head - observable via attempts on the rows.
    const rowsA = await alice.store.listMessages(peerA);
    const rowsB = await alice.store.listMessages(peerB);
    expect(rowsA.find(m => m.direction === 'out' && m.createdAtMs === rowsA[0].createdAtMs)).toBeDefined();
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(1);
    // The first message in conversation A failed once (no transport, so
    // Queued); the second is still untouched (Sending, 0 attempts).
    expect(rowsA[0].status).toBe('Queued');
    expect(rowsA[0].attempts).toBe(1);
    const second = rowsA[1];
    expect(second.status).toBe('Sending');
    expect(second.attempts).toBe(0);
    expect(rowsB[0].attempts).toBe(1); // conversation B was not blocked by A
  });

  test('send order is preserved end to end on the relay path', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 30_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'one');
    await alice.service.sendMessage(bob.meshHex, 'two');
    await alice.service.sendMessage(bob.meshHex, 'three');
    await alice.service.flushOutbox();
    await tick();
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread.map(t => t.text)).toEqual(['one', 'two', 'three']);
    // Sender rows left Sending/Queued/Failed nowhere: each is Relayed, or
    // already Delivered if the peer ack round-tripped during the tick.
    const sent = await alice.service.getThread(bob.meshHex);
    expect(sent.map(t => t.status).every(s => s === 'Relayed' || s === 'Delivered')).toBe(true);
  });

  test('flushOutbox runs conversations concurrently but keeps per-conversation order', async () => {
    // A relay that takes 100ms per publish: sequential conversations
    // would take 300ms for 3 messages, concurrent conversations ~200ms
    // (conversation A has 2 messages in order, B has 1 alongside).
    const published: string[] = [];
    const slowRelay = {
      async publish(envelope: { recipientHex: string }): Promise<DmRelayPublishResult> {
        await new Promise<void>(r => setTimeout(r, 100));
        published.push(envelope.recipientHex);
        return { accepted: true, rejected: false };
      },
      async publishAck(): Promise<DmRelayPublishResult> {
        return { accepted: false, rejected: false };
      },
      subscribe(): () => void {
        return () => {};
      },
    };
    const nowRef = { now: 50_000_000 };
    const alice = makePersona(slowRelay as never, nowRef);
    const peerA = dmToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    const peerB = dmToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    await alice.service.sendMessage(peerA, 'a1');
    await alice.service.sendMessage(peerA, 'a2');
    await alice.service.sendMessage(peerB, 'b1');
    const started = Date.now();
    await alice.service.flushOutbox();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(280);
    expect(published).toHaveLength(3);
    expect(published.filter(p => p === peerA)).toEqual([peerA, peerA]);
    const sent = await alice.service.getThread(peerA);
    expect(sent.map(t => t.status)).toEqual(['Relayed', 'Relayed']);
  });

  test('validation: bad peer hex, self-DM, empty and over-cap text are rejected', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 40_000_000 };
    const alice = makePersona(relay, nowRef);
    await expect(alice.service.sendMessage('xyz', 'hi')).rejects.toThrow();
    await expect(alice.service.sendMessage(alice.meshHex, 'hi')).rejects.toThrow();
    await expect(alice.service.sendMessage('d'.repeat(64), '')).rejects.toThrow();
    await expect(alice.service.sendMessage('d'.repeat(64), 'x'.repeat(5000))).rejects.toThrow();
  });

  test('P1-06: repeat delivery of the same relay event id renders once', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 50_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const envelope = sealDm('same text twice', alice.meshHex, bob.meshHex);
    const delivered = { ...envelope, relayEventId: 'relay-event-1' };
    expect(await bob.service.receiveEnvelope(delivered)).toBe('request');
    expect(await bob.service.receiveEnvelope(delivered)).toBe('ignored');
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    const convs = await bob.service.listRequests();
    expect(convs[0].unread).toBe(1);
    // Identical text under a different event id is a distinct message.
    const second = { ...sealDm('same text twice', alice.meshHex, bob.meshHex), relayEventId: 'relay-event-2' };
    expect(await bob.service.receiveEnvelope(second)).toBe('request');
    expect(await bob.service.getThread(alice.meshHex)).toHaveLength(2);
  });

  test('P1-12: own send to an ignored request promotes it to inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 70_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    // Bob receives from unknown alice, then ignores the request.
    await bob.service.receiveEnvelope(sealDm('hey', alice.meshHex, bob.meshHex));
    await bob.service.ignoreRequest(alice.meshHex);
    expect(await bob.service.listRequests()).toHaveLength(0);
    expect(await bob.service.listInbox()).toHaveLength(0);
    // Bob now messages alice first: the conversation must surface in inbox.
    await bob.service.sendMessage(alice.meshHex, 'actually hi');
    const inbox = await bob.service.listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].peerHex).toBe(alice.meshHex);
    expect(inbox[0].ignored).toBe(false);
  });

  test('F6: thread orders by sender time, not arrival time', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 80_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const late = sealDm('sent later', alice.meshHex, bob.meshHex, 2000);
    const early = sealDm('sent earlier', alice.meshHex, bob.meshHex, 1000);
    await bob.service.receiveEnvelope(late);
    await bob.service.receiveEnvelope(early);
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread.map(t => t.text)).toEqual(['sent earlier', 'sent later']);
  });

  test('F7: blocking fails queued Sending rows so they can be retried after unblock', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 90_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'f'.repeat(64);
    await alice.service.sendMessage(peer, 'queued when blocked');
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Sending');
    await alice.service.blockPeer(peer);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    // Unblock, then tap-to-retry re-queues the row.
    await alice.service.unblockPeer(peer);
    await alice.service.retryMessage(peer, rows[0].id);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Sending');
  });

  test('F8: unblock from a request restores the request, not inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 95_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    await bob.service.receiveEnvelope(sealDm('stranger hi', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
    await bob.service.blockPeer(alice.meshHex);
    await bob.service.unblockPeer(alice.meshHex);
    expect(await bob.service.listInbox()).toHaveLength(0);
    expect(await bob.service.listRequests()).toHaveLength(1);
    // And an inbox conversation still restores to inbox.
    await bob.service.acceptRequest(alice.meshHex);
    await bob.service.blockPeer(alice.meshHex);
    await bob.service.unblockPeer(alice.meshHex);
    expect(await bob.service.listInbox()).toHaveLength(1);
  });

  test('F14-retry: concurrent flushes share one run and publish once', async () => {
    class DelayedCountingRelay implements DmRelayPort {
      calls = 0;
      async publish(): Promise<DmRelayPublishResult> {
        this.calls += 1;
        await new Promise(r => setTimeout(r, 30));
        return { accepted: true, rejected: false };
      }
      async publishAck(): Promise<DmRelayPublishResult> {
        return { accepted: false, rejected: false };
      }
      subscribe(): () => void {
        return () => {};
      }
    }
    const relay = new DelayedCountingRelay();
    const nowRef = { now: 100_000_000 };
    const alice = makePersona(relay, nowRef);
    await alice.service.sendMessage('a'.repeat(64), 'guard me');
    await Promise.all([alice.service.flushOutbox(), alice.service.flushOutbox()]);
    expect(relay.calls).toBe(1);
    const rows = await alice.store.listMessages('a'.repeat(64));
    expect(rows[0].status).toBe('Relayed');
    alice.service.stop();
  });

  test('F15: restart keeps the outbox sendable (envelope persisted) and the queue moving', async () => {
    const relay = new TogglingRelay();
    const nowRef = { now: 110_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'first after restart');
    await alice.service.sendMessage(peer, 'second after restart');
    alice.service.stop();
    // A fresh service over the same store simulates a restart: rows now
    // carry their persisted envelope, so the flush attempts them (no
    // transport here, so Queued) instead of failing them outright.
    const restarted = new DmService({
      store: alice.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(alice.secret),
      ownMeshHex: () => alice.meshHex,
      now: () => nowRef.now,
    });
    await restarted.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Queued');
    expect(rows[1].status).toBe('Sending'); // FIFO: head blocked the second row
    // The transport returns: a forced flush drains both, in order.
    relay.accept = true;
    await restarted.flushOutbox(true);
    rows = await alice.store.listMessages(peer);
    expect(rows.map(r => r.status)).toEqual(['Relayed', 'Relayed']);
    restarted.stop();
  });

  test('F15b: a row with neither envelope nor plaintext fails fast, queue continues past it', async () => {
    const relay = new TogglingRelay();
    relay.accept = true;
    const nowRef = { now: 111_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.store.addMessage({
      id: 'dead-row',
      peerHex: peer,
      direction: 'out',
      sealed: 'stale',
      createdAtMs: nowRef.now,
      status: 'Sending',
      attempts: 0,
      nextAttemptAtMs: nowRef.now,
    });
    await alice.service.sendMessage(peer, 'alive after dead');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows.map(r => r.status)).toEqual(['Failed', 'Relayed']);
  });

  test('F15c: a row with plaintext but no envelope re-seals and sends', async () => {
    const relay = new TogglingRelay();
    relay.accept = true;
    const nowRef = { now: 112_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    // Flush iterates conversations, so the conversation row must exist
    // for a hand-built outbox row to be flushed at all.
    await alice.service.startConversation(peer);
    await alice.store.addMessage({
      id: 'reseal-row',
      peerHex: peer,
      direction: 'out',
      sealed: 'stale',
      plainText: 'resealed text',
      createdAtMs: nowRef.now,
      status: 'Sending',
      attempts: 0,
      nextAttemptAtMs: nowRef.now,
    });
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
    expect(rows[0].envelope).toBeDefined();
    expect(rows[0].deliveryId).toBeDefined();
    expect(rows[0].ackProof).toBeDefined();
  });

  test('F16: per-conversation message lists cap with oldest eviction', async () => {
    const store = new MemoryDmStore();
    const peer = 'd'.repeat(64);
    for (let i = 0; i < 1005; i++) {
      await store.addMessage({
        id: `msg-${i}`,
        peerHex: peer,
        direction: 'in',
        sealed: 'sealed',
        createdAtMs: i,
        status: 'Delivered',
        attempts: 0,
        nextAttemptAtMs: i,
      });
    }
    const rows = await store.listMessages(peer);
    expect(rows).toHaveLength(1000);
    expect(rows[0].id).toBe('msg-5');
    expect(rows[rows.length - 1].id).toBe('msg-1004');
  });

  test('F24: garbage peer ids are rejected before any row is created', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 120_000_000 };
    const alice = makePersona(relay, nowRef);
    await expect(alice.service.blockPeer('garbage')).rejects.toThrow();
    await expect(alice.service.unblockPeer('garbage')).rejects.toThrow();
    await expect(alice.service.mutePeer('garbage', true)).rejects.toThrow();
    await expect(alice.service.acceptRequest('garbage')).rejects.toThrow();
    await expect(alice.service.ignoreRequest('garbage')).rejects.toThrow();
    await expect(alice.service.deleteConversationLocalOnly('garbage')).rejects.toThrow();
    await expect(alice.service.markRead('garbage')).rejects.toThrow();
    await expect(alice.service.getThread('garbage')).rejects.toThrow();
    await expect(alice.service.getConversation('garbage')).rejects.toThrow();
    await expect(alice.service.previewFor('garbage')).rejects.toThrow();
    await expect(alice.service.retryMessage('garbage', 'nope')).rejects.toThrow();
    expect(await alice.service.listBlocked()).toHaveLength(0);
    expect(await alice.service.listInbox()).toHaveLength(0);
  });

  test('D11: whitespace-only DMs are rejected at the service', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 130_000_000 };
    const alice = makePersona(relay, nowRef);
    await expect(alice.service.sendMessage('d'.repeat(64), '   ')).rejects.toThrow();
    await expect(alice.service.sendMessage('d'.repeat(64), '\n\t ')).rejects.toThrow();
    // Non-blank text still sends, stored unchanged.
    await alice.service.sendMessage('d'.repeat(64), '  padded  ');
    const thread = await alice.service.getThread('d'.repeat(64));
    expect(thread).toHaveLength(1);
    expect(thread[0].text).toBe('  padded  ');
  });

  test('P1-09: the flush scheduler re-arms on the backoff and drains without user action', async () => {
    jest.useFakeTimers();
    try {
      const relay = new FailingDmRelay();
      const nowRef = { now: 60_000_000 };
      const alice = makePersona(relay, nowRef);
      alice.service.start();
      await alice.service.sendMessage('e'.repeat(64), 'scheduler please');
      const microtasks = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      };
      await microtasks();
      // The send scheduled a due-now flush; firing it attempts once.
      await jest.advanceTimersByTimeAsync(0);
      await microtasks();
      let rows = await alice.store.listMessages('e'.repeat(64));
      expect(rows[0].attempts).toBe(1);
      expect(rows[0].status).toBe('Queued');
      // Move the fake clock past the 1000ms backoff and fire the re-armed timer.
      nowRef.now += 1000;
      await jest.advanceTimersByTimeAsync(1000);
      await microtasks();
      rows = await alice.store.listMessages('e'.repeat(64));
      expect(rows[0].attempts).toBe(2);
      alice.service.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DM transport parity: honest states, acks, mesh, restart', () => {
  test('relay OK lands in Relayed, and the peer ack upgrades it to Delivered', async () => {
    const nowRef = { now: 200_000_000 };
    // Relayed with no peer ack possible: the recipient never started, so
    // no ack can come back. (Asserting Relayed after a started peer
    // would race the ack round-trip, which upgrades it mid-test.)
    const soloRelay = new MemoryDmRelay();
    const solo = makePersona(soloRelay, nowRef);
    await solo.service.sendMessage('b'.repeat(64), 'relayed only');
    await solo.service.flushOutbox();
    expect((await solo.service.getThread('b'.repeat(64)))[0].status).toBe('Relayed');
    // With both sides started, the peer stores it and acks back through
    // the same relay, upgrading the row to Delivered.
    const relay = new MemoryDmRelay();
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'ack me please');
    await alice.service.flushOutbox();
    await tick();
    await tick();
    const sent = await alice.service.getThread(bob.meshHex);
    expect(sent[0].status).toBe('Delivered');
    expect((await bob.service.getThread(alice.meshHex)).map(t => t.text)).toEqual(['ack me please']);
  });

  test('a forged ack (wrong proof) is ignored; only the true proof delivers', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 210_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'prove it');
    await alice.service.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Queued');
    const deliveryId = rows[0].deliveryId as string;
    // Forged: sealed to alice, but the proof is made up.
    const forged = sealDm(JSON.stringify({ dmAckFor: deliveryId, proof: '0'.repeat(64) }), peer, alice.meshHex);
    expect(await alice.service.receiveAck(forged)).toBe('ignored');
    expect((await alice.store.listMessages(peer))[0].status).toBe('Queued');
    // True proof (the one stored at send time) delivers.
    const valid = sealDm(
      JSON.stringify({ dmAckFor: deliveryId, proof: rows[0].ackProof }),
      peer,
      alice.meshHex,
    );
    expect(await alice.service.receiveAck(valid)).toBe('delivered');
    expect((await alice.store.listMessages(peer))[0].status).toBe('Delivered');
  });

  test('cross-transport duplicate (BLE copy plus relay copy) renders once', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 220_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const envelope = sealDm('one copy only', alice.meshHex, bob.meshHex);
    expect(await bob.service.receiveEnvelope(envelope)).toBe('request');
    // Same send arriving again over the other transport (now carrying a
    // relay event id) is the same delivery id, so it is dropped.
    expect(await bob.service.receiveEnvelope({ ...envelope, relayEventId: 'relay-event-9' })).toBe('ignored');
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    expect((await bob.service.listRequests())[0].unread).toBe(1);
  });

  test('restart keeps thread text and sender order (persisted envelope + timestamps)', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 230_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const late = sealDm('sent later', alice.meshHex, bob.meshHex, 2000);
    const early = sealDm('sent earlier', alice.meshHex, bob.meshHex, 1000);
    await bob.service.receiveEnvelope(late);
    await bob.service.receiveEnvelope(early);
    // Own sent text survives restart too (persisted plaintext column in
    // the SQLite store; here the row itself carries it).
    await alice.service.sendMessage(bob.meshHex, 'my own words');
    const restartedBob = new DmService({
      store: bob.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(bob.secret),
      ownMeshHex: () => bob.meshHex,
      now: () => nowRef.now,
    });
    const restartedAlice = new DmService({
      store: alice.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(alice.secret),
      ownMeshHex: () => alice.meshHex,
      now: () => nowRef.now,
    });
    expect((await restartedBob.getThread(alice.meshHex)).map(t => t.text)).toEqual([
      'sent earlier',
      'sent later',
    ]);
    const own = await restartedAlice.getThread(bob.meshHex);
    expect(own).toHaveLength(1);
    expect(own[0].text).toBe('my own words');
  });

  test('force flush drains Queued rows early; a plain flush respects the backoff', async () => {
    const relay = new TogglingRelay();
    const nowRef = { now: 240_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'drain me');
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Queued');
    expect(rows[0].nextAttemptAtMs).toBeGreaterThan(nowRef.now);
    // Transport returns, but the backoff has not elapsed: a plain flush
    // must not attempt yet.
    relay.accept = true;
    await alice.service.flushOutbox();
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Queued');
    // A forced flush (foreground, connectivity return, peer arrival)
    // drains it now.
    await alice.service.flushOutbox(true);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Relayed');
  });

  test('mesh-only offline: BLE handoff lands in MeshSent, peer ack delivers', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 250_000_000 };
    const aliceMesh = new LoopMesh();
    const bobMesh = new LoopMesh();
    aliceMesh.peer = bobMesh;
    bobMesh.peer = aliceMesh;
    const alice = makePersona(relay, nowRef, aliceMesh);
    const bob = makePersona(relay, nowRef, bobMesh);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'over ble only');
    await alice.service.flushOutbox();
    await tick();
    await tick();
    // The mesh notify went out, and the peer ack came back over mesh:
    // Delivered, with MeshSent as the honest interim (visible if the
    // ack had not arrived yet).
    const sent = await alice.service.getThread(bob.meshHex);
    expect(sent[0].status).toBe('Delivered');
    expect((await bob.service.getThread(alice.meshHex)).map(t => t.text)).toEqual(['over ble only']);
  });

  test('mesh handoff without an ack ends in Failed after the cap, but a late ack still delivers', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 260_000_000 };
    // A mesh that claims a peer took the frames but never acks: use a
    // one-way stub (publish returns 1, subscribe never delivers).
    const oneWay: DmMeshPort = {
      async publish(): Promise<number> {
        return 1;
      },
      subscribe(): () => void {
        return () => {};
      },
    };
    const alice2 = makePersona(relay, nowRef, oneWay);
    await alice2.service.sendMessage('b'.repeat(64), 'into the void');
    await alice2.service.flushOutbox();
    let rows = await alice2.store.listMessages('b'.repeat(64));
    expect(rows[0].status).toBe('MeshSent');
    // Five mesh sends with no ack: force the cap by marking the count,
    // then flush (due now) to terminal Failed.
    rows[0].meshAttempts = 5;
    rows[0].nextAttemptAtMs = nowRef.now;
    await alice2.store.updateMessage(rows[0]);
    await alice2.service.flushOutbox();
    rows = await alice2.store.listMessages('b'.repeat(64));
    expect(rows[0].status).toBe('Failed');
    // A late ack from the peer still corrects Failed to Delivered.
    const valid = sealDm(
      JSON.stringify({ dmAckFor: rows[0].deliveryId, proof: rows[0].ackProof }),
      'b'.repeat(64),
      alice2.meshHex,
    );
    expect(await alice2.service.receiveAck(valid)).toBe('delivered');
    rows = await alice2.store.listMessages('b'.repeat(64));
    expect(rows[0].status).toBe('Delivered');
  });
});

describe('DM unread counts', () => {
  test('per-thread counts add up to the tab total; markRead clears one thread', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 300_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const carol = makePersona(relay, nowRef);
    // Unknown senders land in requests first; accept moves them to inbox
    // with their unread counts intact.
    await bob.service.receiveEnvelope(sealDm('a1', alice.meshHex, bob.meshHex));
    await bob.service.receiveEnvelope(sealDm('c1', carol.meshHex, bob.meshHex));
    await bob.service.acceptRequest(alice.meshHex);
    await bob.service.acceptRequest(carol.meshHex);
    await bob.service.receiveEnvelope(sealDm('a2', alice.meshHex, bob.meshHex));
    await bob.service.receiveEnvelope(sealDm('a3', alice.meshHex, bob.meshHex));
    const inbox = await bob.service.listInbox();
    const byPeer = new Map(inbox.map(c => [c.peerHex, c.unread]));
    expect(byPeer.get(alice.meshHex)).toBe(3);
    expect(byPeer.get(carol.meshHex)).toBe(1);
    expect(await bob.service.totalUnread()).toBe(4);
    await bob.service.markRead(alice.meshHex);
    expect(await bob.service.totalUnread()).toBe(1);
    expect((await bob.service.listInbox()).find(c => c.peerHex === alice.meshHex)?.unread).toBe(0);
    expect((await bob.service.listInbox()).find(c => c.peerHex === carol.meshHex)?.unread).toBe(1);
  });

  test('same send delivered twice counts once, even concurrently', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 310_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const env = sealDm('once only', alice.meshHex, bob.meshHex);
    const p1 = bob.service.receiveEnvelope(env);
    const p2 = bob.service.receiveEnvelope(env);
    const verdicts = await Promise.all([p1, p2]);
    expect(verdicts.sort()).toEqual(['ignored', 'request']);
    expect((await bob.service.listRequests())[0].unread).toBe(1);
    expect(await bob.service.getThread(alice.meshHex)).toHaveLength(1);
    // A later replay of the same send still counts nothing.
    expect(await bob.service.receiveEnvelope(env)).toBe('ignored');
    expect((await bob.service.listRequests())[0].unread).toBe(1);
  });

  test('legacy relay-event-id replay after a restart counts nothing', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 320_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const env = sealDm('from an old install', alice.meshHex, bob.meshHex);
    // Legacy senders carry no delivery id; the relay event id is the key.
    const legacy = { ...env, deliveryId: undefined, relayEventId: 'e'.repeat(64) };
    expect(await bob.service.receiveEnvelope(legacy)).toBe('request');
    expect(await bob.service.receiveEnvelope(legacy)).toBe('ignored');
    expect((await bob.service.listRequests())[0].unread).toBe(1);
    // A new service over the same store is a restart: the seen relay
    // event id survived it, so the backfill replay still counts nothing.
    const restarted = new DmService({
      store: bob.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(bob.secret),
      ownMeshHex: () => bob.meshHex,
      now: () => nowRef.now,
    });
    expect(await restarted.receiveEnvelope(legacy)).toBe('ignored');
    expect((await restarted.listRequests())[0].unread).toBe(1);
  });

  test('requests do not feed the tab total; own and blocked messages never count', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 330_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    await bob.service.receiveEnvelope(sealDm('knock knock', alice.meshHex, bob.meshHex));
    await bob.service.receiveEnvelope(sealDm('knock again', alice.meshHex, bob.meshHex));
    expect((await bob.service.listRequests())[0].unread).toBe(2);
    expect(await bob.service.totalUnread()).toBe(0);
    // A message addressed to self is ignored, never counted.
    expect(await bob.service.receiveEnvelope(sealDm('to self', bob.meshHex, bob.meshHex))).toBe('ignored');
    expect(await bob.service.totalUnread()).toBe(0);
    // Blocked sender: dropped before any row or count exists.
    await bob.service.blockPeer(alice.meshHex);
    expect(await bob.service.receiveEnvelope(sealDm('spam', alice.meshHex, bob.meshHex))).toBe('dropped');
    expect(await bob.service.totalUnread()).toBe(0);
    expect(await bob.service.listRequests()).toEqual([]);
  });

  test('muted rows keep their preserved count but stay out of the tab total', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 340_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    await bob.service.receiveEnvelope(sealDm('yo', alice.meshHex, bob.meshHex));
    await bob.service.acceptRequest(alice.meshHex);
    expect((await bob.service.listInbox())[0].unread).toBe(1);
    await bob.service.mutePeer(alice.meshHex, true);
    expect(await bob.service.totalUnread()).toBe(0);
    // A message arriving while muted is stored but never increments.
    await bob.service.receiveEnvelope(sealDm('yo again', alice.meshHex, bob.meshHex));
    expect((await bob.service.getThread(alice.meshHex))).toHaveLength(2);
    expect((await bob.service.listInbox())[0].unread).toBe(1);
    expect(await bob.service.totalUnread()).toBe(0);
    await bob.service.mutePeer(alice.meshHex, false);
    expect(await bob.service.totalUnread()).toBe(1);
  });
});

describe('DM diagnostics events + sequence numbers', () => {
  test('seq travels inside the sealed rumor and the ack proof is unaffected', () => {
    const sender = ed25519.utils.randomSecretKey();
    const recipient = ed25519.utils.randomSecretKey();
    const senderHex = dmToHex(ed25519.getPublicKey(sender));
    const recipientHex = dmToHex(ed25519.getPublicKey(recipient));
    const { envelope, ackProof } = sealDmWithAckProof('numbered', senderHex, recipientHex, 1_700_000_000, 5);
    const rumor = unsealDm(envelope, dmKeypairFromDeviceSecret(recipient), recipientHex);
    expect(rumor?.seq).toBe(5);
    // The proof covers only the delivery id: recomputing it over the
    // seq-carrying envelope still matches the sealed proof.
    expect(dmAckProofForEnvelope(dmKeypairFromDeviceSecret(recipient).secretKey, envelope, envelope.deliveryId as string)).toBe(ackProof);
    // No seq field means no number, never a guessed one.
    const plain = sealDm('unnumbered', senderHex, recipientHex, 1_700_000_000);
    expect(unsealDm(plain, dmKeypairFromDeviceSecret(recipient), recipientHex)?.seq).toBeUndefined();
  });

  test('send, receive and ack each emit a traffic event carrying one number', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 1_000_000 };
    const aliceEvents: DmEvent[] = [];
    const bobEvents: DmEvent[] = [];
    let nextSeq = 7;
    const alice = makePersona(relay, nowRef, undefined, {
      nextDmSeq: async () => nextSeq++,
      onDmEvent: (e) => aliceEvents.push(e),
    });
    const bob = makePersona(relay, nowRef, undefined, {
      onDmEvent: (e) => bobEvents.push(e),
    });
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'trace me');
    await alice.service.flushOutbox();
    await tick();
    await tick();
    const traffic = (events: DmEvent[]) =>
      events.filter((e): e is Extract<DmEvent, { kind: 'traffic' }> => e.kind === 'traffic');
    const aliceSent = traffic(aliceEvents).find((e) => e.direction === 'out' && e.state === 'relayed');
    expect(aliceSent).toBeDefined();
    expect(aliceSent?.seq).toBe(7);
    expect(aliceSent?.sizeBytes).toBeGreaterThan(0);
    const bobReceived = traffic(bobEvents).find((e) => e.direction === 'in' && e.state === 'received');
    expect(bobReceived?.seq).toBe(7);
    const bobAck = traffic(bobEvents).find((e) => e.direction === 'out' && e.state === 'ack-sent');
    expect(bobAck?.seq).toBe(7);
    const aliceAck = traffic(aliceEvents).find((e) => e.direction === 'in' && e.state === 'ack-received');
    expect(aliceAck?.seq).toBe(7);
    const rows = await alice.store.listMessages(bob.meshHex);
    expect(rows[0].status).toBe('Delivered');
    await bob.service.markRead(alice.meshHex);
    expect(bobEvents.some((e) => e.kind === 'state' && e.state === 'thread-read')).toBe(true);
  });

  test('a re-seal reuses the row number instead of taking a fresh one', async () => {
    const relay = new TogglingRelay();
    relay.accept = false;
    const nowRef = { now: 1_000_000 };
    let nextSeq = 7;
    const alice = makePersona(relay, nowRef, undefined, { nextDmSeq: async () => nextSeq++ });
    const bob = makePersona(relay, nowRef);
    await alice.service.sendMessage(bob.meshHex, 'reseal me');
    await alice.service.flushOutbox();
    let rows = await alice.store.listMessages(bob.meshHex);
    expect(rows[0].seq).toBe(7);
    expect(rows[0].status).toBe('Queued');
    // Simulate a restart with a lost envelope: the plaintext survives,
    // so the retry re-seals, and must reuse number 7, not take 8.
    await alice.store.updateMessage({ ...rows[0], envelope: undefined, sealed: '' });
    const alice2 = new DmService({
      store: alice.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(alice.secret),
      ownMeshHex: () => alice.meshHex,
      now: () => nowRef.now,
      nextDmSeq: async () => nextSeq++,
    });
    relay.accept = true;
    // Forced: the stripped row's backoff timer has not elapsed, and
    // this is a retry, not a timer-driven flush.
    await alice2.flushOutbox(true);
    rows = await alice.store.listMessages(bob.meshHex);
    expect(rows[0].seq).toBe(7);
    expect(rows[0].status).toBe('Relayed');
    expect(nextSeq).toBe(8);
    const rumor = unsealDm(rows[0].envelope!, dmKeypairFromDeviceSecret(bob.secret), bob.meshHex);
    expect(rumor?.seq).toBe(7);
  });
});
