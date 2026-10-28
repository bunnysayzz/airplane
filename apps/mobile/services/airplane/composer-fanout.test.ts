// SPDX-License-Identifier: Apache-2.0
// Composer fan-out failure surfacing: a transport-start failure used to
// be swallowed by an empty catch, so a post looked published while its
// fan-out never ran. It must now be recorded in Diagnostics.

jest.mock('./transport', () => ({
  publishViaTransport: jest.fn(async () => {
    throw new Error('transport failed to start; running offline-only');
  }),
}));

import { publishPost } from './composer';
import { setLocationProviderForTests, __resetLocationProviderForTests } from './location';
import { __resetStoreForTests } from './store';
import { __resetDeviceKeypairForTests } from './identity';
import { __resetFeedListenersForTests } from './feed';
import {
  getDiagnosticsSnapshot,
  resetDiagnosticsForTests,
} from './diagnostics';

beforeEach(() => {
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetLocationProviderForTests();
  __resetFeedListenersForTests();
  resetDiagnosticsForTests();
  setLocationProviderForTests({ getCurrentCell: async () => 'tdr1v' });
});

afterEach(() => {
  __resetLocationProviderForTests();
  __resetFeedListenersForTests();
  __resetDeviceKeypairForTests();
});

describe('composer fan-out failure', () => {
  test('a transport-start failure is recorded, not swallowed', async () => {
    const id = await publishPost('fan-out fails', { geohash5: 'tdr1v' });
    expect(typeof id).toBe('string');
    // The fan-out catch runs on a microtask after publishPost returns.
    await new Promise<void>((r) => setTimeout(r, 0));
    const messages = getDiagnosticsSnapshot().messages;
    expect(messages.some((m) => m.finalStatus === 'fan-out failed')).toBe(true);
  });
});
