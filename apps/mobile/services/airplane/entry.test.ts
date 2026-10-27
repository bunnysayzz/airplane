// SPDX-License-Identifier: Apache-2.0
// Entry-point import-order guard (T1 follow-up, v0.1.2).
//
// The post-publish failure on real devices (v0.1.0/v0.1.1) traced to a
// missing random-values polyfill: Hermes provides no
// globalThis.crypto.getRandomValues, so @noble/curves key generation threw
// on first post — while Node/Jest (webcrypto) kept every test green.
// The polyfill import in apps/mobile/index.js MUST stay first, before any
// code that can transitively reach noble (fatalShim, sentry, expo-router).
// This test reads the entry file as text (never imports it: importing
// would pull the RN runtime into the node harness) and fails the suite if
// the import moves or disappears.

import * as fs from 'fs';
import * as path from 'path';

const ENTRY = path.resolve(__dirname, '..', '..', 'index.js');
const APP_PKG = path.resolve(__dirname, '..', '..', 'package.json');

function importLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^import\s+['"]/.test(line) || /^import\s+.*\sfrom\s+['"]/.test(line));
}

describe('app entry import order', () => {
  it('imports react-native-get-random-values first', () => {
    const source = fs.readFileSync(ENTRY, 'utf8');
    const imports = importLines(source);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports[0]).toBe(`import 'react-native-get-random-values';`);
  });

  it('installs the polyfill before fatalShim and expo-router/entry', () => {
    const source = fs.readFileSync(ENTRY, 'utf8');
    const polyfill = source.indexOf(`import 'react-native-get-random-values'`);
    const fatalShim = source.indexOf(`import './src/fatalShim'`);
    const routerEntry = source.indexOf(`import 'expo-router/entry'`);
    expect(polyfill).toBeGreaterThanOrEqual(0);
    expect(fatalShim).toBeGreaterThan(polyfill);
    expect(routerEntry).toBeGreaterThan(polyfill);
  });

  it('declares react-native-get-random-values as an app dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(APP_PKG, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['react-native-get-random-values']).toBeDefined();
  });
});
