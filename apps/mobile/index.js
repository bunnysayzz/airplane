// SPDX-License-Identifier: Apache-2.0
// App entry point (package.json "main").
//
// Import order is load-bearing: the AIRPLANE_FATAL shim MUST stay the first
// import so the global error capture is installed before expo-router (or any
// app code) evaluates. A startup throw then shows up in logcat tagged
// [AIRPLANE_FATAL] instead of killing the process silently.
import './src/fatalShim';
import 'expo-router/entry';
