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
