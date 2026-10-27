// SPDX-License-Identifier: Apache-2.0
// In-memory TransportPort simulator (blueprint TEST-1/TEST-2).
//
// Lets flood/sync/protocol logic run without radios: peers register on a
// shared SimMedium, frames are delivered with configurable latency and
// drop probability. Pure TypeScript, no react-native imports.

import type { TransportPort, PeerInfo, UnixSec } from '@airplane/protocol';

/** Constructor options for {@link SimMedium}. */
export interface SimMediumOpts {
  /** Delivery latency per frame, ms. Default 5. */
  latencyMs?: number;
  /** Probability [0, 1] that a delivery is dropped. Default 0. */
  dropRate?: number;
}

type BytesHandler = (fromPeerId: string, bytes: Uint8Array) => void;

/**
 * The shared "air": routes frames between registered peers.
 * `broadcast` reaches every peer except the sender; `unicast` reaches one.
 * Every delivery is delayed by `latencyMs` and dropped with `dropRate`
 * probability, independently per destination.
 */
export class SimMedium {
  private readonly handlers = new Map<string, BytesHandler>();
  private readonly latencyMs: number;
  private readonly dropRate: number;

  constructor(opts: SimMediumOpts = {}) {
    this.latencyMs = opts.latencyMs ?? 5;
    this.dropRate = opts.dropRate ?? 0;
    if (this.dropRate < 0 || this.dropRate > 1) {
      throw new Error(`SimMedium: dropRate must be in [0, 1], got ${this.dropRate}`);
    }
  }

  register(peerId: string, onBytes: BytesHandler): void {
    this.handlers.set(peerId, onBytes);
  }

  unregister(peerId: string): void {
    this.handlers.delete(peerId);
  }

  /** Currently registered peer ids. */
  peerIds(): string[] {
    return [...this.handlers.keys()];
  }

  broadcast(fromPeerId: string, bytes: Uint8Array): void {
    for (const to of this.handlers.keys()) {
      if (to !== fromPeerId) this.deliver(fromPeerId, to, bytes);
    }
  }

  unicast(fromPeerId: string, toPeerId: string, bytes: Uint8Array): void {
    this.deliver(fromPeerId, toPeerId, bytes);
  }

  private deliver(fromPeerId: string, toPeerId: string, bytes: Uint8Array): void {
    const cb = this.handlers.get(toPeerId);
    if (!cb) return;
    if (Math.random() < this.dropRate) return;
    const latency = this.latencyMs;
    const copy = bytes.slice();
    setTimeout(() => cb(fromPeerId, copy), latency);
  }
}

/**
 * In-memory TransportPort. `scan` reports every peer registered on the
 * medium (rssi -50, platform unknown); `connect`/`disconnect` track a local
 * connection set; `send` unicasts and throws when not connected.
 */
export class SimTransport implements TransportPort {
  private readonly connected = new Set<string>();
  private rx: BytesHandler | null = null;

  constructor(
    private readonly medium: SimMedium,
    readonly peerId: string,
  ) {
    // Register a dispatcher up front so scan() sees the peer immediately;
    // frames are only forwarded once onReceive() installs a handler.
    this.medium.register(peerId, (from, bytes) => {
      this.rx?.(from, bytes);
    });
  }

  async advertise(_peerId: string): Promise<void> {
    // No-op in the sim: discovery is the medium's peer registry.
  }

  async stopAdvertise(): Promise<void> {
    // No-op in the sim (advertise is a no-op).
  }

  async scan(onPeer: (peer: PeerInfo) => void): Promise<() => void> {
    const nowSec: UnixSec = Math.floor(Date.now() / 1000);
    for (const id of this.medium.peerIds()) {
      onPeer({ peerId: id, rssi: -50, lastSeenSec: nowSec });
    }
    // Sim discovery is one-shot; the real BLE transport (P3) re-fires onPeer
    // as advertisements are re-heard. Matches the frozen TransportPort.
    return () => {};
  }

  async connect(peerId: string): Promise<void> {
    this.connected.add(peerId);
  }

  async disconnect(peerId: string): Promise<void> {
    this.connected.delete(peerId);
  }

  /** Test seam: is this transport currently connected to `peerId`? */
  isConnected(peerId: string): boolean {
    return this.connected.has(peerId);
  }

  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    if (!this.connected.has(peerId)) {
      throw new Error(`SimTransport(${this.peerId}): not connected to ${peerId}`);
    }
    this.medium.unicast(this.peerId, peerId, bytes);
  }

  onReceive(cb: BytesHandler): () => void {
    this.rx = cb;
    return () => {
      this.rx = null;
      this.medium.unregister(this.peerId);
    };
  }
}

/** 16 lowercase hex chars, matching the rotating BLE peer-id format. */
export function randomPeerId(): string {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  let out = '';
  for (let i = 0; i < b.length; i++) {
    out += b[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Convenience factory for multi-peer tests: one shared medium,
 * `createPeer` hands out transports with random peer ids.
 */
export class SimNetwork {
  readonly medium: SimMedium;

  constructor(opts: SimMediumOpts = {}) {
    this.medium = new SimMedium(opts);
  }

  createPeer(_name: string): { peerId: string; transport: SimTransport } {
    const peerId = randomPeerId();
    return { peerId, transport: new SimTransport(this.medium, peerId) };
  }

  peerCount(): number {
    return this.medium.peerIds().length;
  }
}
