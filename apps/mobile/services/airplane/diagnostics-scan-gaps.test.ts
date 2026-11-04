// SPDX-License-Identifier: Apache-2.0
// Unit tests for gaps 109 and 110: the comparable scan summary line
// (labeled window plus unique counts) and the mesh-drop line when mesh
// sightings fall to zero after previously being seen.

import {
  recordScanSightings,
  resetDiagnosticsForTests,
  setDiagnosticsLogSink,
} from './diagnostics';

const lines: string[] = [];

beforeEach(() => {
  resetDiagnosticsForTests();
  lines.length = 0;
  setDiagnosticsLogSink((kind, detail) => {
    lines.push(`${kind} ${detail}`);
  });
});

afterEach(() => {
  resetDiagnosticsForTests();
  setDiagnosticsLogSink(null);
});

describe('gap 109: comparable scan summaries', () => {
  it('labels the window and reports unique counts alongside event totals', () => {
    recordScanSightings(10, 3, 7, 'ffff:8', 65000, 4, 2);
    expect(lines).toEqual([
      'scan sightings window=65000ms total=10 mesh=3 nonmesh=7 unique=4 meshUnique=2 md=ffff:8',
    ]);
  });

  it('two windows with the same totals but different windows stay distinguishable', () => {
    recordScanSightings(100, 50, 50, 'ffff:8', 60000, 2, 1);
    recordScanSightings(100, 50, 50, 'ffff:8', 120000, 2, 1);
    expect(lines[0]).toContain('window=60000ms');
    expect(lines[1]).toContain('window=120000ms');
  });
});

describe('gap 110: mesh sightings drop to zero', () => {
  it('emits one drop line when mesh falls to zero after being seen, and again after mesh returns', () => {
    recordScanSightings(100, 40, 60, 'ffff:8', 60000, 5, 1);
    expect(lines).not.toContain('scan mesh-sightings-zero-after-seen');
    recordScanSightings(90, 0, 90, 'ffff:8', 60000, 5, 0);
    expect(lines).toContain('scan mesh-sightings-zero-after-seen');
    // A further zero window does not repeat the line for the same drop.
    recordScanSightings(80, 0, 80, 'ffff:8', 60000, 4, 0);
    expect(lines.filter((line) => line === 'scan mesh-sightings-zero-after-seen')).toHaveLength(1);
    // Mesh returns, then drops again: a fresh drop line for the new drop.
    recordScanSightings(100, 30, 70, 'ffff:8', 60000, 5, 1);
    recordScanSightings(90, 0, 90, 'ffff:8', 60000, 5, 0);
    expect(lines.filter((line) => line === 'scan mesh-sightings-zero-after-seen')).toHaveLength(2);
  });

  it('emits no drop line when mesh was never seen', () => {
    recordScanSightings(90, 0, 90, 'ffff:8', 60000, 5, 0);
    expect(lines).not.toContain('scan mesh-sightings-zero-after-seen');
  });
});
