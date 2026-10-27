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
  WebSocketLike,
  WebSocketFactory,
} from './nostr';

export { BleTransport, HybridTransport } from './hybrid';
export type { HybridTransportOpts, IngressSource } from './hybrid';

export { WorldSync } from './sync';
export type { SyncReport, WorldConfirmStore } from './sync';

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
export type { WsDmRelayOpts } from './dmRelay';
