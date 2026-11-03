// SPDX-License-Identifier: Apache-2.0
// @airplane mobile services - public surface (replaces services/mastodon/*).

export type { PostCardModel } from './types';
export {
  listFeedPosts,
  listFeedPage,
  subscribeFeed,
  notifyFeedListeners,
  authorLabelFor,
  toPostCardModel,
  type FeedQueryOpts,
  type FeedPageOpts,
  type FeedPageCursor,
  type FeedPage,
  type FeedListener,
} from './feed';
export { publishPost, tagsForPublish, type PublishOpts } from './composer';
export {
  trackViewability,
  extractNewViewIds,
  emitViewReceipt,
  type ViewabilityInfo,
} from './viewTracker';
export {
  getDeviceKeypair,
  getDevicePublicKey,
  setKeyStore,
  signWithDeviceKey,
  signDeviceEvent,
  rotateDeviceKey,
  onIdentityChange,
  crypto,
  type DeviceKeypair,
  type RotationResult,
} from './identity';
export { getStore, closeStore } from './store';
// --- RESHARE (delimited) ---
export {
  recordReshareEvent,
  markResharePostKnown,
  getReshareCluster,
  resharerLabelFor,
  toggleReshare,
  getMyPubkeyHex,
  rehydrateReshares,
  reshareViewFor,
} from './reshares';
// --- IDENTITY: display names, peer registry, username resolution, avatars ---
export {
  DISPLAY_NAME_TAG,
  DISPLAY_NAME_MAX_CHARS,
  avatarGradientFor,
  displayNameFromEvent,
  displayNameFromTags,
  formatPeerName,
  getOwnDisplayName,
  hydratePeerDisplayNames,
  knownDisplayName,
  knownPeerHexes,
  matchKnownPeers,
  memorableNameForHex,
  normalizeDisplayName,
  peerBaseName,
  recordDisplayNameFromTags,
  recordPeerDisplayName,
  resolvePeerNames,
  setOwnDisplayName,
  __resetDisplayNamesForTests,
} from './displayNames';
export { memorableNameFor, nameWithoutSuffix } from './names';
export { getKv } from './kv';
export { startTransport, stopTransport, publishViaTransport, pruneExpiredStore, drainPostOutbox } from './transport';
