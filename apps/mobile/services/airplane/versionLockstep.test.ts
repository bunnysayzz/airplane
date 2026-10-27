// SPDX-License-Identifier: Apache-2.0
// PL1 tests: version lockstep guard.
//
// apps/mobile/app.json is the single source of truth for the app version:
// build.gradle derives versionName and versionCode from it at configuration
// time, and apps/mobile/package.json mirrors it. These tests fail if anyone
// hardcodes a version in build.gradle again, or lets the sources drift
// apart. They read the files from disk (no React Native runtime needed),
// so they run in the node Jest harness alongside the updater tests.

import * as fs from 'fs';
import * as path from 'path';

import { parseVersion } from './updater';

// services/airplane -> apps/mobile.
const mobileDir = path.join(__dirname, '..', '..');

const readText = (relativePath: string): string =>
  fs.readFileSync(path.join(mobileDir, relativePath), 'utf8');

const readJson = (relativePath: string): Record<string, unknown> =>
  JSON.parse(readText(relativePath)) as Record<string, unknown>;

// app.json carries full-line // comments (Expo tolerates them), so
// comment lines are stripped before parsing; strict JSON parsing would
// fail on the file as written.
const readAppJson = (): Record<string, unknown> => {
  const stripped = readText('app.json')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped) as Record<string, unknown>;
};

describe('version lockstep (PL1)', () => {
  test('app.json version is a parseable semver', () => {
    const appJson = readAppJson();
    const expo = appJson.expo as Record<string, unknown>;
    expect(typeof expo.version).toBe('string');
    expect(parseVersion(expo.version as string)).not.toBeNull();
  });

  test('build.gradle derives the version from app.json, never hardcodes it', () => {
    const gradle = readText('android/app/build.gradle');
    expect(gradle).toContain('app.json');
    expect(gradle).not.toMatch(/versionCode\s+\d+/);
    expect(gradle).not.toMatch(/versionName\s+"/);
  });

  test('package.json version mirrors app.json version', () => {
    const appJson = readAppJson();
    const expo = appJson.expo as Record<string, unknown>;
    const pkg = readJson('package.json');
    expect(pkg.version).toBe(expo.version);
  });

  test('derived versionCode rises with the version', () => {
    const appJson = readAppJson();
    const expo = appJson.expo as Record<string, unknown>;
    const parts = (expo.version as string).split('.').map(Number);
    const code = parts[0] * 10000 + parts[1] * 100 + parts[2];
    // The last shipped hardcoded versionCode was 5; any version at or
    // above 0.1.9 derives a code above it, so upgrades keep working.
    expect(code).toBeGreaterThan(5);
  });
});
