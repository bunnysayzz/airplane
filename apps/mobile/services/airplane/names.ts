// SPDX-License-Identifier: Apache-2.0
// Anonymous author display names (extracted from feed.ts so both the feed
// mapper and the reshare registry can use them without an import cycle).
// 64 adjectives x 64 nouns, indexed by pubkey bytes 2 and 3, plus the first
// 4 hex chars of the pubkey: ~268M combinations. Deterministic function of
// the already-public pubkey, so it reveals nothing beyond the pubkey itself.

import { toHex } from '@airplane/protocol';

export const NAME_ADJECTIVES = [
  'amber', 'arctic', 'autumn', 'azure', 'bold', 'brave', 'bright', 'calm',
  'cedar', 'clever', 'cobalt', 'copper', 'coral', 'crimson', 'crisp', 'daring',
  'dawn', 'deep', 'dusky', 'eager', 'ember', 'emerald', 'faint', 'fierce',
  'fleet', 'frosty', 'gentle', 'golden', 'granite', 'happy', 'hazy', 'hidden',
  'hollow', 'honest', 'ivory', 'jade', 'joyful', 'keen', 'kind', 'leafy',
  'lively', 'lone', 'lucid', 'lunar', 'mellow', 'merry', 'misty', 'moonlit',
  'nimble', 'noble', 'ocean', 'opal', 'pastel', 'patient', 'pearl', 'pine',
  'placid', 'proud', 'quiet', 'rapid', 'regal', 'river', 'rocky', 'royal',
];

export const NAME_NOUNS = [
  'fox', 'wolf', 'owl', 'bear', 'deer', 'hawk', 'otter', 'badger',
  'raven', 'falcon', 'heron', 'moose', 'bison', 'coyote', 'lynx', 'panda',
  'koala', 'tiger', 'eagle', 'sparrow', 'robin', 'wren', 'finch', 'crow',
  'dove', 'goose', 'swan', 'duck', 'crane', 'elk', 'hare', 'mole',
  'vole', 'shrew', 'bat', 'mouse', 'rabbit', 'squirrel', 'chipmunk', 'beaver',
  'mink', 'weasel', 'ferret', 'stoat', 'marten', 'sable', 'jaguar', 'leopard',
  'cheetah', 'panther', 'cougar', 'bobcat', 'ocelot', 'yak', 'ibex', 'chamois',
  'oryx', 'gazelle', 'zebra', 'lion', 'camel', 'donkey', 'goat', 'sheep',
];

/** Stable, anonymous display name for an author pubkey. */
export function authorLabelFor(pubkey: Uint8Array): string {
  const adjective = NAME_ADJECTIVES[(pubkey[2] ?? 0) % NAME_ADJECTIVES.length];
  const noun = NAME_NOUNS[(pubkey[3] ?? 0) % NAME_NOUNS.length];
  return `${adjective} ${noun}·${toHex(pubkey).slice(0, 4)}`;
}
