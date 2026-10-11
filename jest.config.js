// SPDX-License-Identifier: Apache-2.0
const path = require('path');

const rootDir = __dirname;

const pkg = (name) => ({
  displayName: name,
  testEnvironment: 'node',
  rootDir: path.join(rootDir, 'packages', name),
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleNameMapper: {
    '^@airplane/([^/]+)$': path.join(rootDir, 'packages', '$1', 'src'),
  },
  // @noble/* and cbor-x ship pure ESM; ts-jest must transpile them instead of
  // letting Jest try a CJS require ("Must use import to load ES Module").
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: { allowJs: true, esModuleInterop: true } }],
  },
  transformIgnorePatterns: ['node_modules/(?!(cbor-x|@noble/curves|@noble/hashes)/)'],
});

module.exports = {
  // Coverage gates: fail the run if coverage drops below these floors.
  // Current (2026-10-11): ~90% stmts / 80% branches / 85% funcs / 91% lines.
  // Thresholds sit just below to catch regressions without blocking
  // incremental progress. Raise them as untested modules gain tests.
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 75,
      functions: 80,
      lines: 85,
    },
  },
  collectCoverageFrom: [
    // Paths are relative to each project's rootDir (packages/<name> or
    // apps/mobile), so keep them project-local. Only directories with test
    // coverage are included; UI components and i18n are excluded (they need
    // a React Native test harness, tracked separately).
    'src/**/*.ts',
    'services/airplane/*.ts',
    '!**/*.test.ts',
    '!**/__tests__/**',
    '!**/__mocks__/**',
    '!**/test-helpers*',
    // Native stubs: can't run in Node, excluded from coverage.
    '!src/op-sqlite.ts',
    '!src/mmkv.ts',
    // Mobile UI support files: no unit tests (need RN harness).
    '!src/i18n/**',
    '!src/lib/**',
    '!src/theme/**',
    // Pure re-export barrels and type-only modules: nothing to execute.
    '!**/index.ts',
    '!**/types.ts',
    '!**/ports.ts',
  ],
  projects: [
    pkg('protocol'),
    pkg('storage'),
    pkg('crypto'),
    pkg('mesh-sim'),
    pkg('transport'),
    {
      displayName: 'mobile-services',
      testEnvironment: 'node',
      rootDir: path.join(rootDir, 'apps', 'mobile'),
      testMatch: ['<rootDir>/services/**/*.test.ts'],
      moduleNameMapper: {
        '^@airplane/([^/]+)$': path.join(rootDir, 'packages', '$1', 'src'),
        '^@react-native-community/netinfo$': path.join(rootDir, '__mocks__', '@react-native-community', 'netinfo.ts'),
      },
      transform: {
        '^.+\\.[tj]sx?$': [
          'ts-jest',
          {
            tsconfig: {
              allowJs: true,
              esModuleInterop: true,
              target: 'es2022', // else ** downlevels to Math.pow and @noble/curves breaks on BigInt
            },
          },
        ],
      },
      transformIgnorePatterns: ['node_modules/(?!(cbor-x|@noble/curves|@noble/hashes)/)'],
    },
  ],
};
