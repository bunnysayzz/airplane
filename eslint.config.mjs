// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// NOTE (P1): react-native / expo lint plugins are intentionally NOT added yet.
// The mobile app lands in a later phase; react-hooks / react-native plugins
// will be introduced when apps/mobile gets real JSX beyond the bootstrap.

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/android/**', '**/ios/**', '**/.expo/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Underscore-prefixed args/vars are intentionally unused (interface
    // conformance, stub signatures). Standard convention, allowed project-wide.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain Node config files (not part of the TS program).
    files: ['**/*.config.js', '**/babel.config.js', '**/jest.config.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // @airplane/protocol must stay pure TypeScript: no react-native or expo
    // imports allowed. Enforced in CI via `npm run lint`.
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react-native', 'react-native/*'],
              message: 'packages/protocol must stay platform-free; use the port/adapter boundary instead.',
            },
            {
              group: ['expo', 'expo-*', 'expo/*'],
              message: 'packages/protocol must stay platform-free; use the port/adapter boundary instead.',
            },
          ],
        },
      ],
    },
  },
);
