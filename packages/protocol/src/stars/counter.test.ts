// SPDX-License-Identifier: Apache-2.0
// StarCounter: the six counting rules, tested directly (report §4).

import { NobleCrypto, verifyEvent } from '../sign/ed25519';
import { createStarEvent, createUnstarEvent } from '../payloads/stars';
import { fromHex, toHex } from '../hex';
import { StarCounter, formatStarCount } from './counter';

const crypto = new NobleCrypto();
const NOW = 1_800_000_000;
const POST = 'a'.repeat(64);

function keypair() {
  return crypto.generateKeypair();
}

function star(
  kp: { publicKey: Uint8Array; secretKey: Uint8Array },
  createdAt: number,
  unstar = false,
) {
  const mk = unstar ? createUnstarEvent : createStarEvent;
  return mk({
    crypto,
    secretKey: kp.secretKey,
    pubkey: kp.publicKey,
    geohash5: 'tdr1v',
    postId: fromHex(POST),
    createdAt,
  });
}

function tampered(event: ReturnType<typeof star>) {
  // Same fields, forged signature: id recomputation still matches, but the
  // signature does not verify against the pubkey.
  return { ...event, sig: new Uint8Array(64) };
}

describe('StarCounter', () => {
  test('dedup across transports: same event twice counts once', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    const e = star(kp, NOW);
    expect(c.apply(e, (ev) => verifyEvent(crypto, ev), NOW)).toBe('applied');
    expect(c.apply(e, (ev) => verifyEvent(crypto, ev), NOW)).toBe('duplicate');
    expect(c.view(POST).count).toBe(1);
  });

  test('one counted star per (pubkey, post): two stars from one key count once', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    expect(c.apply(star(kp, NOW), (ev) => verifyEvent(crypto, ev), NOW)).toBe('applied');
    expect(c.apply(star(kp, NOW + 10), (ev) => verifyEvent(crypto, ev), NOW + 10)).toBe(
      'applied',
    );
    expect(c.view(POST).count).toBe(1);
    expect(c.view(POST).seenEvents).toBe(2);
  });

  test('latest-wins undo, including out-of-order unstar-then-star arrival', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    const s1 = star(kp, NOW);
    const u = star(kp, NOW + 20, true);
    // The unstar (newer) arrives FIRST, then the older star: the cancelled
    // star must not resurrect.
    expect(c.apply(u, (ev) => verifyEvent(crypto, ev), NOW + 20)).toBe('applied');
    expect(c.view(POST).count).toBe(0);
    expect(c.apply(s1, (ev) => verifyEvent(crypto, ev), NOW + 20)).toBe('superseded');
    expect(c.view(POST).count).toBe(0);
    // A still-newer star re-stars.
    expect(c.apply(star(kp, NOW + 30), (ev) => verifyEvent(crypto, ev), NOW + 30)).toBe(
      'applied',
    );
    expect(c.view(POST).count).toBe(1);
    // And a newer unstar cancels again.
    expect(c.apply(star(kp, NOW + 40, true), (ev) => verifyEvent(crypto, ev), NOW + 40)).toBe(
      'applied',
    );
    expect(c.view(POST).count).toBe(0);
  });

  test('unverified star is never counted (forged signature)', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    const bad = tampered(star(kp, NOW));
    expect(verifyEvent(crypto, bad)).toBe(false);
    expect(c.apply(bad, (ev) => verifyEvent(crypto, ev), NOW)).toBe('unverified');
    expect(c.view(POST).count).toBe(0);
    expect(c.view(POST).seenEvents).toBe(0);
  });

  test('own star is visible immediately (optimistic): apply -> starred, count 1', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const me = keypair();
    const meHex = toHex(me.publicKey);
    expect(c.view(POST, meHex).starredByMe).toBe(false);
    expect(c.apply(star(me, NOW), (ev) => verifyEvent(crypto, ev), NOW)).toBe('applied');
    const v = c.view(POST, meHex);
    expect(v.starredByMe).toBe(true);
    expect(v.count).toBe(1);
  });

  test('star for an unseen post is held pending and applied when the post arrives', () => {
    const c = new StarCounter();
    const kp = keypair();
    expect(c.apply(star(kp, NOW), (ev) => verifyEvent(crypto, ev), NOW)).toBe('pending');
    expect(c.view(POST).count).toBe(0);
    expect(c.view(POST).pendingEvents).toBe(1);
    c.markPostKnown(POST);
    expect(c.view(POST).count).toBe(1);
    expect(c.view(POST).pendingEvents).toBe(0);
  });

  test('future-dated events beyond skew, bad content, and wrong kind are invalid', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    expect(c.apply(star(kp, NOW + 10_000), (ev) => verifyEvent(crypto, ev), NOW)).toBe(
      'invalid',
    );
    const wrongContent = { ...star(kp, NOW), content: 'like' };
    expect(c.apply(wrongContent, () => true, NOW)).toBe('invalid');
    expect(c.view(POST).count).toBe(0);
  });

  test('same-second tie-break is deterministic: larger id hex wins regardless of arrival order', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    const s = star(kp, NOW);
    const u = star(kp, NOW, true);
    const [first, second] = toHex(s.id) > toHex(u.id) ? [s, u] : [u, s];
    // Apply in an order that fights the tie-break: the loser first.
    c.apply(second, (ev) => verifyEvent(crypto, ev), NOW);
    c.apply(first, (ev) => verifyEvent(crypto, ev), NOW);
    const winnerIsStar = toHex(s.id) > toHex(u.id);
    expect(c.view(POST).count).toBe(winnerIsStar ? 1 : 0);
  });

  test('different keys count independently', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const a = keypair();
    const b = keypair();
    c.apply(star(a, NOW), (ev) => verifyEvent(crypto, ev), NOW);
    c.apply(star(b, NOW), (ev) => verifyEvent(crypto, ev), NOW);
    expect(c.view(POST).count).toBe(2);
  });
});

describe('formatStarCount', () => {
  test('partial / lower-bound display: positive counts get "+", zero gets no numeral', () => {
    expect(formatStarCount(0)).toBe('');
    expect(formatStarCount(1)).toBe('1+');
    expect(formatStarCount(42)).toBe('42+');
  });
});

describe('StarCounter per-post index', () => {
  test('view for one post ignores stars on many other posts', () => {
    const c = new StarCounter();
    c.markPostKnown(POST);
    const kp = keypair();
    c.apply(star(kp, NOW), (ev) => verifyEvent(crypto, ev), NOW);
    for (let i = 0; i < 50; i++) {
      const other = (i + 1).toString(16).padStart(64, '0');
      c.markPostKnown(other);
      const ev = createStarEvent({
        crypto,
        secretKey: kp.secretKey,
        pubkey: kp.publicKey,
        geohash5: 'tdr1v',
        postId: fromHex(other),
        createdAt: NOW,
      });
      c.apply(ev, (e) => verifyEvent(crypto, e), NOW);
    }
    expect(c.view(POST).count).toBe(1);
    expect(c.view(POST).starredByMe).toBe(false);
    expect(c.view(POST, toHex(kp.publicKey)).starredByMe).toBe(true);
  });
});
