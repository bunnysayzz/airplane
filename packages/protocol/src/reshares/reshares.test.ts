// SPDX-License-Identifier: Apache-2.0
import { NobleCrypto, verifyEvent } from '../sign/ed25519';
import { encodeEvent, decodeEvent } from '../codec/cbor';
import { EVENT_KIND_RESHARE, toHex, type SignedEvent } from '../index';
import { createPost } from '../payloads/posts';
import {
  createReshare,
  createUnreshare,
  flattenReshareTarget,
  flattenParamsForCard,
  reshareTargetId,
  reshareViaId,
} from '../payloads/reshares';
import { ReshareCounter } from './counting';

const crypto = new NobleCrypto();
const GEOHASH = 'ezs42';

function keypair() {
  return crypto.generateKeypair();
}
function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}
function verify(e: SignedEvent) {
  return verifyEvent(crypto, e);
}

describe('reshare event shape (tiny reference, no post content)', () => {
  test('carries only original id + author ref + resharer pubkey, never post text', () => {
    const author = keypair();
    const resharer = keypair();
    const postBody = 'a very distinctive post body that must never be embedded';
    const ev = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: bytes32(7),
      originalAuthorPubkey: author.publicKey,
    });
    expect(ev.kind).toBe(EVENT_KIND_RESHARE);
    expect(ev.content).toBe('');
    expect(ev.content).not.toContain(postBody);
    expect(JSON.stringify(ev)).not.toContain(postBody);
    expect(reshareTargetId(ev)).toBe(toHex(bytes32(7)));
    expect(ev.pubkey).toEqual(resharer.publicKey);
    // Reshare size is independent of post body length: it stays smaller than
    // a max-length post's encoding (fixed overhead dominates for short posts,
    // so the meaningful comparison is against a 280-char post).
    const longPost = createPost({
      crypto,
      secretKey: author.secretKey,
      pubkey: author.publicKey,
      geohash5: GEOHASH,
      content: 'x'.repeat(280),
    });
    expect(encodeEvent(ev).length).toBeLessThan(encodeEvent(longPost).length);
    expect(verifyEvent(crypto, ev)).toBe(true);
    expect(decodeEvent(encodeEvent(ev)).kind).toBe(EVENT_KIND_RESHARE);
  });
});

describe('flattening: reshare-of-reshare lands on the original', () => {
  test('count lands on original, never on the wrapper', () => {
    const author = keypair();
    const first = keypair();
    const second = keypair();
    const originalId = bytes32(9);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));

    const wrapper = createReshare({
      crypto,
      secretKey: first.secretKey,
      pubkey: first.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
    });
    expect(counter.add(wrapper, verify)).toBe('counted');

    // Second user reshares the WRAPPER card: flatten to the original.
    const params = flattenParamsForCard(
      {
        crypto,
        secretKey: second.secretKey,
        pubkey: second.publicKey,
        geohash5: GEOHASH,
      },
      wrapper,
      author.publicKey,
    );
    expect(params).toBeDefined();
    const resharedWrapper = createReshare(params!);
    expect(reshareTargetId(resharedWrapper)).toBe(toHex(originalId));
    expect(reshareViaId(resharedWrapper)).toBe(toHex(wrapper.id));
    expect(counter.add(resharedWrapper, verify)).toBe('counted');

    expect(counter.count(toHex(originalId))).toBe(2);
    // The wrapper id itself is never a counting key.
    expect(counter.count(toHex(wrapper.id))).toBe(0);
    expect(flattenReshareTarget(wrapper)).toBe(toHex(originalId));
  });
});

describe('feed collapse: a reshare never duplicates the card', () => {
  test('one card per original post regardless of reshare count', () => {
    const author = keypair();
    const originalId = bytes32(11);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));
    // Feed is built from kind-1 posts only; reshares are annotations on them.
    const feedPosts = [{ id: toHex(originalId) }];
    for (let i = 0; i < 5; i++) {
      const r = keypair();
      const ev = createReshare({
        crypto,
        secretKey: r.secretKey,
        pubkey: r.publicKey,
        geohash5: GEOHASH,
        originalPostId: originalId,
        originalAuthorPubkey: author.publicKey,
        createdAt: 1000 + i,
      });
      expect(counter.add(ev, verify)).toBe('counted');
    }
    expect(counter.count(toHex(originalId))).toBe(5);
    // Cards are derived from posts, not from reshare events: still one card.
    const cards = feedPosts.map((p) => ({ postId: p.id, reshares: counter.count(p.id) }));
    expect(cards).toHaveLength(1);
    expect(cards[0].reshares).toBe(5);
    const cluster = counter.cluster(toHex(originalId));
    expect(cluster.count).toBe(5);
    expect(cluster.latestResharer).not.toBeNull();
  });
});

describe('counting: one per key, dedup across transports', () => {
  test('three reshares from one pubkey count once; redelivery counts once', () => {
    const author = keypair();
    const resharer = keypair();
    const originalId = bytes32(13);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));
    for (const t of [100, 200, 300]) {
      const ev = createReshare({
        crypto,
        secretKey: resharer.secretKey,
        pubkey: resharer.publicKey,
        geohash5: GEOHASH,
        originalPostId: originalId,
        originalAuthorPubkey: author.publicKey,
        createdAt: t,
      });
      counter.add(ev, verify);
    }
    expect(counter.count(toHex(originalId))).toBe(1);
    // Same event delivered again via a second transport: duplicate, no change.
    const ev = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 100,
    });
    expect(counter.add(ev, verify)).toBe('duplicate');
    expect(counter.count(toHex(originalId))).toBe(1);
  });
});

describe('latest-wins undo, including out-of-order arrival', () => {
  test('unreshare drops the count; a late older reshare cannot resurrect it', () => {
    const author = keypair();
    const resharer = keypair();
    const originalId = bytes32(15);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));
    const mk = (t: number, undo: boolean) =>
      undo
        ? createUnreshare({
            crypto,
            secretKey: resharer.secretKey,
            pubkey: resharer.publicKey,
            geohash5: GEOHASH,
            originalPostId: originalId,
            originalAuthorPubkey: author.publicKey,
            createdAt: t,
          })
        : createReshare({
            crypto,
            secretKey: resharer.secretKey,
            pubkey: resharer.publicKey,
            geohash5: GEOHASH,
            originalPostId: originalId,
            originalAuthorPubkey: author.publicKey,
            createdAt: t,
          });
    expect(counter.add(mk(100, false), verify)).toBe('counted');
    expect(counter.count(toHex(originalId))).toBe(1);
    expect(counter.add(mk(200, true), verify)).toBe('counted');
    expect(counter.count(toHex(originalId))).toBe(0);
    expect(counter.hasReshared(toHex(resharer.publicKey), toHex(originalId))).toBe(false);
    // Stale reshare (t=150) arriving after its unreshare (t=200): superseded.
    expect(counter.add(mk(150, false), verify)).toBe('superseded');
    expect(counter.count(toHex(originalId))).toBe(0);
    // A newer reshare re-activates.
    expect(counter.add(mk(300, false), verify)).toBe('counted');
    expect(counter.count(toHex(originalId))).toBe(1);
  });

  test('unreshare arriving BEFORE its reshare still wins (same-author order)', () => {
    const author = keypair();
    const resharer = keypair();
    const originalId = bytes32(17);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));
    const un = createUnreshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 200,
    });
    const re = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 100,
    });
    expect(counter.add(un, verify)).toBe('counted');
    expect(counter.add(re, verify)).toBe('superseded');
    expect(counter.count(toHex(originalId))).toBe(0);
  });
});

describe('verification before counting', () => {
  test('unverified reshare is never counted; a genuine same-id event still counts', () => {
    const author = keypair();
    const resharer = keypair();
    const originalId = bytes32(19);
    const counter = new ReshareCounter();
    counter.markPostKnown(toHex(originalId));
    const genuine = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 100,
    });
    const forged = { ...genuine, sig: new Uint8Array(64).fill(1) };
    expect(counter.add(forged, verify)).toBe('ignored');
    expect(counter.count(toHex(originalId))).toBe(0);
    // The forged attempt left no seen-set trace: the genuine event counts.
    expect(counter.add(genuine, verify)).toBe('counted');
    expect(counter.count(toHex(originalId))).toBe(1);
  });
});

describe('pending reshares apply when the original post later arrives', () => {
  test('held, not dropped; count appears on markPostKnown', () => {
    const author = keypair();
    const resharer = keypair();
    const originalId = bytes32(21);
    const counter = new ReshareCounter();
    const ev = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: originalId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 100,
    });
    expect(counter.add(ev, verify)).toBe('pending');
    expect(counter.count(toHex(originalId))).toBe(0);
    expect(counter.pendingCount()).toBe(1);
    counter.markPostKnown(toHex(originalId));
    expect(counter.pendingCount()).toBe(0);
    expect(counter.count(toHex(originalId))).toBe(1);
    expect(counter.hasReshared(toHex(resharer.publicKey), toHex(originalId))).toBe(true);
  });
});

describe('latestFor (toggle monotonicity seam)', () => {
  test('returns the newest event for (pubkey, post), null when none seen', () => {
    const counter = new ReshareCounter();
    const author = keypair();
    const resharer = keypair();
    const postId = bytes32(7);
    expect(counter.latestFor(toHex(postId), toHex(resharer.publicKey))).toBeNull();
    const first = createReshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: postId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 1_700_000_000,
    });
    counter.markPostKnown(toHex(postId));
    expect(counter.add(first, verify)).toBe('counted');
    expect(counter.latestFor(toHex(postId), toHex(resharer.publicKey))?.created_at).toBe(
      1_700_000_000,
    );
    const second = createUnreshare({
      crypto,
      secretKey: resharer.secretKey,
      pubkey: resharer.publicKey,
      geohash5: GEOHASH,
      originalPostId: postId,
      originalAuthorPubkey: author.publicKey,
      createdAt: 1_700_000_001,
    });
    expect(counter.add(second, verify)).toBe('counted');
    expect(counter.latestFor(toHex(postId), toHex(resharer.publicKey))?.content).toBe('undo');
  });
});
