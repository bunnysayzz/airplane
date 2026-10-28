// SPDX-License-Identifier: Apache-2.0
// ErrorBoundary copy mapping: raw messages (paths, hex, internals) never
// render; known classes get friendly copy, the rest get the generic line.

import { friendlyErrorMessage } from './errorCopy';

describe('friendlyErrorMessage', () => {
  test('maps known classes to friendly copy', () => {
    expect(friendlyErrorMessage(new Error('network request failed'))).toContain('connection');
    expect(friendlyErrorMessage(new Error('permission denied'))).toContain('permission');
    expect(friendlyErrorMessage(new Error('sqlite: no such table'))).toContain('Saved data');
  });

  test('unknown errors get the generic line, never the raw message', () => {
    const raw = 'Error: /data/data/app/airplane.db missing key ab'.concat('cd'.repeat(30));
    expect(friendlyErrorMessage(new Error(raw))).toBe('Something went wrong. Try again.');
    expect(friendlyErrorMessage(new Error(raw))).not.toContain('airplane.db');
    expect(friendlyErrorMessage(new Error(raw))).not.toContain('abcd');
    expect(friendlyErrorMessage(null)).toBe('Something went wrong. Try again.');
    expect(friendlyErrorMessage('plain string')).toBe('Something went wrong. Try again.');
  });
});
