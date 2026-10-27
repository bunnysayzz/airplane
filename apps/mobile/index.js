// SPDX-License-Identifier: Apache-2.0
// App entry point (package.json "main").
//
// Import order is load-bearing:
// 1. react-native-get-random-values FIRST: Hermes has no
//    globalThis.crypto.getRandomValues, and @noble/curves key generation
//    (ed25519 randomSecretKey, used on first post) throws without it.
//    The polyfill must be installed before ANY noble code can run —
//    including transitively via fatalShim/sentry — so it stays above
//    every other import. A regression test (services/airplane/entry.test.ts)
//    fails the suite if this import moves or disappears.
// 2. The AIRPLANE_FATAL shim next, so the global error capture is installed
//    before expo-router (or any app code) evaluates. A startup throw then
//    shows up in logcat tagged [AIRPLANE_FATAL] instead of killing the
//    process silently.
import 'react-native-get-random-values';
import './src/fatalShim';
// Sentry (pure-JS envelope client, no native module): self-inits on import
// and stays disabled when EXPO_PUBLIC_SENTRY_DSN is absent. Must stay after
// fatalShim and before expo-router/entry.
import './src/sentry';
import 'expo-router/entry';
