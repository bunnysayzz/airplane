// SPDX-License-Identifier: Apache-2.0
// DM relay port over plain WebSocket (no Google services).
//
// The on-wire event is a valid NIP-01 event (kind 1059, gift-wrap-shaped):
// id = sha256([0, pubkey, created_at, kind, tags, content]), schnorr-signed
// with a fresh ephemeral secp256k1 key per send. `content` is the JSON
// DmEnvelope (ephemeral X25519 pubkey + recipient hex + sealed rumor); the
// `p` tag carries the recipient mesh hex so relays can filter with
// {"kinds":[1059],"#p":[ownHex]}. Relays see recipient + ephemeral pubkey,
// never plaintext. Signature validity is what relays check; the app-level
// trust boundary is the sealed rumor (see dm.ts header).

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { dmFromHex, dmToHex, type DmEnvelope } from './dm';
import type { DmRelayPort } from './dmService';
import { DEFAULT_RELAYS, type WebSocketLike } from './nostr';

export interface WsDmRelayOpts {
  relays?: string[];
  wsFactory?: (url: string) => WebSocketLike;
  /** Per-attempt publish timeout, ms. Default 10000. */
  publishTimeoutMs?: number;
}

interface NostrDmEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function dmEnvelopeToNostrEvent(envelope: DmEnvelope): NostrDmEvent {
  const keys = schnorr.utils.randomPrivateKey();
  const pubkey = dmToHex(schnorr.getPublicKey(keys));
  const tags = [['p', envelope.recipientHex]];
  const content = JSON.stringify(envelope);
  // NIP-01: id = sha256([0, pubkey, created_at, kind, tags, content]);
  // sig = schnorr(id) over the raw id bytes.
  const idBytes = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, envelope.createdAt, 1059, tags, content])));
  return {
    id: dmToHex(idBytes),
    pubkey,
    created_at: envelope.createdAt,
    kind: 1059,
    tags,
    content,
    sig: dmToHex(schnorr.sign(idBytes, keys)),
  };
}

export function nostrEventToDmEnvelope(event: NostrDmEvent): DmEnvelope | null {
  if (event.kind !== 1059) return null;
  try {
    const envelope = JSON.parse(event.content) as DmEnvelope;
    if (
      typeof envelope.ephemeralPubkeyHex !== 'string' ||
      typeof envelope.recipientHex !== 'string' ||
      typeof envelope.sealed !== 'string'
    ) {
      return null;
    }
    // The event's own p tag must name the envelope recipient: a relay
    // must not be able to re-address an event to a different recipient.
    if (
      !Array.isArray(event.tags) ||
      !event.tags.some(tag => tag[0] === 'p' && tag[1] === envelope.recipientHex)
    ) {
      return null;
    }
    // Verify the Nostr id and schnorr signature with the same construction
    // the sender used, so a relay cannot forge 1059 events claiming any
    // sender. This stops relay forgery, not peer forgery by a party that
    // seals correctly (that needs the separate sender-auth protocol fix).
    if (typeof event.created_at !== 'number') return null;
    const pubkeyBytes = dmFromHex(event.pubkey);
    const idBytes = dmFromHex(event.id);
    const sigBytes = dmFromHex(event.sig);
    if (!pubkeyBytes || pubkeyBytes.length !== 32) return null;
    if (!idBytes || idBytes.length !== 32) return null;
    if (!sigBytes || sigBytes.length !== 64) return null;
    const expectedId = sha256(
      new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, 1059, event.tags, event.content])),
    );
    if (dmToHex(expectedId) !== event.id) return null;
    if (!schnorr.verify(sigBytes, idBytes, pubkeyBytes)) return null;
    envelope.relayEventId = event.id;
    return envelope;
  } catch {
    return null;
  }
}

export class WsDmRelay implements DmRelayPort {
  private readonly relays: string[];
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly publishTimeoutMs: number;
  private subSockets: WebSocketLike[] = [];
  /**
   * First-built Nostr event per envelope, keyed by envelope bytes. A retry
   * publishes the identical event (same id, same ephemeral key) instead of
   * minting a fresh event id, so relays and the inbound dedup see one
   * logical send. Bounded with oldest eviction; the envelope's ephemeral
   * pubkey already makes each logical send a distinct key.
   */
  private readonly eventCache = new Map<string, { id: string; message: string }>();

  constructor(opts: WsDmRelayOpts = {}) {
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => {
        const WS = (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket;
        return new WS(url);
      });
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 10000;
  }

  /** Publish to relays in order; true when ANY relay answers OK. */
  async publish(envelope: DmEnvelope): Promise<boolean> {
    const key = JSON.stringify(envelope);
    let cached = this.eventCache.get(key);
    if (!cached) {
      const event = dmEnvelopeToNostrEvent(envelope);
      cached = { id: event.id, message: JSON.stringify(['EVENT', event]) };
      if (this.eventCache.size >= 500) {
        const oldest = this.eventCache.keys().next();
        if (!oldest.done) this.eventCache.delete(oldest.value);
      }
      this.eventCache.set(key, cached);
    }
    for (const url of this.relays) {
      try {
        const ok = await this.publishOne(url, cached.message, cached.id);
        if (ok) return true;
      } catch {
        // Try the next relay.
      }
    }
    return false;
  }

  private publishOne(url: string, message: string, eventId: string): Promise<boolean> {
    return new Promise(resolve => {
      let ws: WebSocketLike;
      try {
        ws = this.wsFactory(url);
      } catch {
        resolve(false);
        return;
      }
      // First outcome wins: close() fires onclose synchronously on fake
      // and real sockets alike, so a success close must not let onclose
      // overwrite the OK, and a timeout close must not double-resolve.
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const closeQuietly = (): void => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
      const timer = setTimeout(() => {
        closeQuietly();
        finish(false);
      }, this.publishTimeoutMs);
      ws.onopen = () => {
        try {
          ws.send(message);
        } catch {
          closeQuietly();
          finish(false);
        }
      };
      ws.onmessage = ev => {
        try {
          const data = JSON.parse(String(ev.data)) as unknown[];
          if (data[0] === 'OK' && data[1] === eventId && data[2] === true) {
            finish(true);
            closeQuietly();
          }
        } catch {
          // Not an OK frame; keep waiting until timeout.
        }
      };
      ws.onerror = () => {
        closeQuietly();
        finish(false);
      };
      ws.onclose = () => {
        // A relay that closes without an OK or an error used to stall
        // until the full per-attempt timeout; resolve immediately instead.
        finish(false);
      };
    });
  }

  /** Open one subscription per relay for kind-1059 events addressed to ownHex. */
  subscribe(ownMeshHex: string, onEnvelope: (e: DmEnvelope) => void): () => void {
    const filter = JSON.stringify({ kinds: [1059], '#p': [ownMeshHex] });
    const subId = `dm-${ownMeshHex.slice(0, 8)}`;
    // Set by unsubscribe: stops all reconnect retries for this subscription.
    let closed = false;
    const sockets: WebSocketLike[] = [];
    const openSocket = (url: string): void => {
      let ws: WebSocketLike;
      try {
        ws = this.wsFactory(url);
      } catch {
        // Relay unreachable: other relays still subscribe.
        return;
      }
      sockets.push(ws);
      let reconnectScheduled = false;
      const scheduleReconnect = (): void => {
        // Error and close often fire for the same drop; schedule once per
        // socket so a drop reopens exactly one replacement socket.
        if (closed || reconnectScheduled) return;
        reconnectScheduled = true;
        setTimeout(() => {
          if (closed) return;
          openSocket(url);
        }, 2000);
      };
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['REQ', subId, JSON.parse(filter)]));
        } catch {
          // ignore; a drop here surfaces via onerror/onclose and reconnects
        }
      };
      ws.onmessage = ev => {
        try {
          const data = JSON.parse(String(ev.data)) as unknown[];
          if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
            const envelope = nostrEventToDmEnvelope(data[2] as NostrDmEvent);
            if (envelope && envelope.recipientHex === ownMeshHex) onEnvelope(envelope);
          }
        } catch {
          // Malformed relay frame: ignore, never crash.
        }
      };
      ws.onerror = () => {
        scheduleReconnect();
      };
      ws.onclose = () => {
        scheduleReconnect();
      };
    };
    for (const url of this.relays) openSocket(url);
    this.subSockets = sockets;
    return () => {
      closed = true;
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      this.subSockets = this.subSockets.filter(s => !sockets.includes(s));
    };
  }
}
