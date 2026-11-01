// SPDX-License-Identifier: Apache-2.0
// Wi-Fi LAN port adapter (T15 Phase 1, Android only).
//
// Wraps the AirplaneLan native module (NSD discovery + TCP server,
// AirplaneLanModule.kt) behind the platform-free LanPort interface in
// packages/transport/src/lan.ts. The native module is lazy-required
// and every native failure fails closed to inert, exactly like the BLE
// port: a missing module (iOS, Expo Go, a build without the manually
// registered package) means no LAN peers and no LAN sends, never a
// launch crash. LAN discovery needs no runtime permission on Android
// (NSD runs on the INTERNET + ACCESS_NETWORK_STATE declarations).
//
// Privacy: peer ids are full pubkey hex, the same identity posts
// already carry. This adapter never logs them; the Diagnostics screen
// shows only a peer count, and the transport log records attempts by
// transport name, not by peer id.

import type { LanPort } from '@airplane/transport';

export interface LanNative {
  startLan: (pubkeyHex: string) => Promise<boolean>;
  stopLan: () => Promise<boolean>;
  sendLan: (peerId: string, base64: string) => Promise<boolean>;
}

type PeerEvent = { peerId: string; host: string; port: number; present: boolean };
type FrameEvent = { base64: string };
type Subscription = { remove: () => void };

/** Test seam: injected native module replaces the NativeModules lookup. */
let nativeOverride: LanNative | null | undefined;
let emitterOverride: {
  addListener: (event: string, cb: (payload: never) => void) => Subscription;
} | null = null;

export function __setLanNativeForTests(
  native: LanNative | null,
  emitter: {
    addListener: (event: string, cb: (payload: never) => void) => Subscription;
  } | null,
): void {
  nativeOverride = native;
  emitterOverride = emitter;
}

export function __resetLanForTests(): void {
  nativeOverride = undefined;
  emitterOverride = null;
}

function getNative(): LanNative | null {
  if (nativeOverride !== undefined) return nativeOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    const mod = rn?.NativeModules?.AirplaneLan as LanNative | undefined;
    if (!mod || typeof mod.startLan !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

function getEmitter(): {
  addListener: (event: string, cb: (payload: never) => void) => Subscription;
} | null {
  if (emitterOverride !== null) return emitterOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    if (!rn?.NativeModules?.AirplaneLan || typeof rn.NativeEventEmitter !== 'function') return null;
    return new rn.NativeEventEmitter(rn.NativeModules.AirplaneLan);
  } catch {
    return null;
  }
}

/** App-side LanPort: the native module plus the JS peer map from its events. */
export interface AppLanPort extends LanPort {
  /** True when the native module is present (Android build with the package). */
  hasNative(): boolean;
  /** True when start ran with a native module and an identity, so NSD is registered. */
  isActive(): boolean;
  /** Subscribe to peer-list changes. Returns unsubscribe. */
  onPeersChanged(cb: () => void): () => void;
}

class LanPortAdapter implements AppLanPort {
  private readonly peers = new Map<string, { host: string; port: number }>();
  private readonly receivers = new Set<(bytes: Uint8Array) => void>();
  private readonly peerListeners = new Set<() => void>();
  private readonly native: LanNative | null;
  private subscriptions: Subscription[] = [];
  private started = false;

  constructor(private readonly pubkeyHex: string) {
    this.native = getNative();
  }

  hasNative(): boolean {
    return this.native !== null;
  }

  isActive(): boolean {
    return this.started && this.native !== null && this.pubkeyHex !== '';
  }

  onPeersChanged(cb: () => void): () => void {
    this.peerListeners.add(cb);
    return () => {
      this.peerListeners.delete(cb);
    };
  }

  private notifyPeersChanged(): void {
    for (const cb of this.peerListeners) {
      try {
        cb();
      } catch {
        // listener errors must not break discovery
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.native) return; // inert: no native module, no peers, no sends
    if (!this.pubkeyHex) return; // inert: no identity, register no service
    const emitter = getEmitter();
    if (emitter) {
      this.subscriptions = [
        emitter.addListener('AirplaneLanPeer', (payload: unknown) => {
          const event = payload as PeerEvent;
          if (!event || typeof event.peerId !== 'string') return;
          // Never track our own advertisement as a peer: NSD echoes our
          // own service back on some devices, and sending to ourselves
          // would only ever echo our own post back to us.
          if (event.peerId === this.pubkeyHex) return;
          if (event.present) {
            this.peers.set(event.peerId, { host: event.host, port: event.port });
          } else {
            this.peers.delete(event.peerId);
          }
          this.notifyPeersChanged();
        }),
        emitter.addListener('AirplaneLanFrame', (payload: unknown) => {
          const event = payload as FrameEvent;
          if (!event || typeof event.base64 !== 'string') return;
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(Buffer.from(event.base64, 'base64'));
          } catch {
            return; // malformed frame - drop
          }
          for (const cb of this.receivers) {
            try {
              cb(bytes);
            } catch {
              // receiver errors must not break the port
            }
          }
        }),
      ];
    }
    try {
      await this.native.startLan(this.pubkeyHex);
    } catch {
      // Native start failure: inert, like a missing module.
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions.splice(0)) {
      try {
        sub.remove();
      } catch {
        // ignore
      }
    }
    this.peers.clear();
    this.started = false;
    if (!this.native) return;
    try {
      await this.native.stopLan();
    } catch {
      // Stopping must never throw into the app lifecycle.
    }
  }

  discoveredPeerIds(): string[] {
    return [...this.peers.keys()];
  }

  async send(peerId: string, bytes: Uint8Array): Promise<void> {
    if (!this.native) throw new Error('LAN native module unavailable');
    const base64 = Buffer.from(bytes).toString('base64');
    const ok = await this.native.sendLan(peerId, base64);
    if (!ok) throw new Error('LAN send failed');
  }

  frameSizeFor(): number {
    // The native module sends one TCP frame per call; the transport
    // default (LAN_FRAME_MAX) already applies when this is absent, but
    // stating it here keeps the bound visible at the port boundary.
    return 8192;
  }

  onReceive(cb: (bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }
}

/**
 * Build a LAN port for this device's pubkey. An empty pubkey (identity
 * not yet readable) yields an inert port that never calls native: an
 * NSD service with no identity would advertise a peer nobody can
 * address, so no service is registered at all.
 */
export function makeLanPort(pubkeyHex: string): AppLanPort {
  if (!pubkeyHex) {
    return new LanPortAdapter('');
  }
  return new LanPortAdapter(pubkeyHex);
}
