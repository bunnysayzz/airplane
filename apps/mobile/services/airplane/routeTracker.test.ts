// SPDX-License-Identifier: Apache-2.0
// Route transition tracker tests: static names, forward/back
// classification, launch redirect silence, and the stack cap.

import {
  getRouteTrackerStackForTests,
  observeRoutePath,
  resetRouteTrackerForTests,
  staticScreenName,
} from './routeTracker';

describe('staticScreenName', () => {
  test('maps tab, post, dm, and index paths to static names', () => {
    expect(staticScreenName('/(tabs)/feed')).toBe('feed');
    expect(staticScreenName('/(tabs)/messages')).toBe('messages');
    expect(staticScreenName('/(tabs)/settings')).toBe('settings');
    expect(staticScreenName('/post/0123456789abcdef')).toBe('post');
    expect(staticScreenName('/dm/' + 'ab'.repeat(32))).toBe('dm');
    expect(staticScreenName('/')).toBe('index');
    expect(staticScreenName('')).toBe('index');
  });
});

describe('observeRoutePath', () => {
  beforeEach(() => {
    resetRouteTrackerForTests();
  });

  test('first path pushes with no event; same path repeats silently', () => {
    expect(observeRoutePath('/(tabs)/feed')).toBeNull();
    expect(observeRoutePath('/(tabs)/feed')).toBeNull();
    expect(getRouteTrackerStackForTests()).toEqual(['/(tabs)/feed']);
  });

  test('push logs forward; return to the previous path logs back', () => {
    observeRoutePath('/(tabs)/feed');
    expect(observeRoutePath('/post/abc')).toEqual({ direction: 'forward', screen: 'post' });
    expect(observeRoutePath('/(tabs)/feed')).toEqual({ direction: 'back', screen: 'feed' });
    expect(getRouteTrackerStackForTests()).toEqual(['/(tabs)/feed']);
  });

  test('launch redirect from index logs nothing', () => {
    expect(observeRoutePath('/')).toBeNull();
    expect(observeRoutePath('/(tabs)/feed')).toBeNull();
    expect(getRouteTrackerStackForTests()).toEqual(['/(tabs)/feed']);
  });

  test('tab switch logs a forward transition (tap line covers the tap)', () => {
    observeRoutePath('/(tabs)/feed');
    expect(observeRoutePath('/(tabs)/messages')).toEqual({ direction: 'forward', screen: 'messages' });
  });

  test('stack is capped at 50 entries', () => {
    for (let i = 0; i < 55; i += 1) observeRoutePath(`/post/${i}`);
    expect(getRouteTrackerStackForTests()).toHaveLength(50);
  });
});
