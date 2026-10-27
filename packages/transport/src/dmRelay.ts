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
import { dmToHex, type DmEnvelope } from './dm';
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
    const event = dmEnvelopeToNostrEvent(envelope);
    const message = JSON.stringify(['EVENT', event]);
    for (const url of this.relays) {
      try {
        const ok = await this.publishOne(url, message, event.id);
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
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(false);
      }, this.publishTimeoutMs);
      ws.onopen = () => {
        try {
          ws.send(message);
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      };
      ws.onmessage = ev => {
        try {
          const data = JSON.parse(String(ev.data)) as unknown[];
          if (data[0] === 'OK' && data[1] === eventId && data[2] === true) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve(true);
          }
        } catch {
          // Not an OK frame; keep waiting until timeout.
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /** Open one subscription per relay for kind-1059 events addressed to ownHex. */
  subscribe(ownMeshHex: string, onEnvelope: (e: DmEnvelope) => void): () => void {
    const filter = JSON.stringify({ kinds: [1059], '#p': [ownMeshHex] });
    const sockets: WebSocketLike[] = [];
    for (const url of this.relays) {
      try {
        const ws = this.wsFactory(url);
        sockets.push(ws);
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify(['REQ', `dm-${ownMeshHex.slice(0, 8)}`, JSON.parse(filter)]));
          } catch {
            // ignore; relay reconnect is the transport's job, not this sub's
          }
        };
        ws.onmessage = ev => {
          try {
            const data = JSON.parse(String(ev.data)) as unknown[];
            if (data[0] === 'EVENT' && data[2]) {
              const envelope = nostrEventToDmEnvelope(data[2] as NostrDmEvent);
              if (envelope && envelope.recipientHex === ownMeshHex) onEnvelope(envelope);
            }
          } catch {
            // Malformed relay frame: ignore, never crash.
          }
        };
      } catch {
        // Relay unreachable: other relays still subscribe.
      }
    }
    this.subSockets = sockets;
    return () => {
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
