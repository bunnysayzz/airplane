// SPDX-License-Identifier: Apache-2.0
// @airplane/transport - public surface.

export {
  NostrTransport,
  generateNostrKeypair,
  wrapEvent,
  unwrapEvent,
  nostrEventId,
  AIRPLANE_NOSTR_KIND,
  AIRPLANE_TAG,
  DEFAULT_RELAYS,
} from './nostr';
export type {
  NostrEvent,
  NostrKeypair,
  NostrTransportOpts,
  RelayState,
  RelayPublishAck,
  WebSocketLike,
  WebSocketFactory,
} from './nostr';

export { BleTransport, HybridTransport, DEFAULT_RELAY_DEADLINE_MS } from './hybrid';
export type { HybridTransportOpts, HybridDiagnosticsOpts, IngressSource, RouterOpts, RouterStatus, RouterTransport, RouteResult } from './hybrid';

export { WorldSync } from './sync';
export type { SyncReport, WorldConfirmStore } from './sync';

export { normalizeRelayUrl, sanitizeRelayList } from './relayUrls';
export type { RelayUrlOpts } from './relayUrls';

export {
  DM_TEXT_MAX_BYTES,
  DM_MAX_ATTEMPTS,
  DM_BACKOFF_MS,
  DM_UNDECRYPTABLE_PLACEHOLDER,
  dmToHex,
  dmFromHex,
  isHex64,
  dmToBase64,
  dmFromBase64,
  chacha20,
  meshPubkeyToX25519,
  dmKeypairFromDeviceSecret,
  dmConversationKey,
  dmConversationKeyX,
  nip44Encrypt,
  nip44Decrypt,
  sealDm,
  unsealDm,
} from './dm';
export type { DmKeypair, DmRumor, DmEnvelope } from './dm';

export {
  DmService,
  MemoryDmStore,
  MemoryDmRelay,
  FailingDmRelay,
} from './dmService';
export type {
  DmDelivery,
  DmConversationState,
  DmMessageRow,
  DmConversationRow,
  DmThreadRow,
  DmStorePort,
  DmRelayPort,
  DmServiceOpts,
} from './dmService';

export { WsDmRelay, dmEnvelopeToNostrEvent, nostrEventToDmEnvelope } from './dmRelay';
export type { WsDmRelayOpts, DmRelayHealth } from './dmRelay';
