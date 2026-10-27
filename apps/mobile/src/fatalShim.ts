// SPDX-License-Identifier: Apache-2.0
/**
 * AIRPLANE_FATAL startup crash capture shim.
 *
 * This module MUST be the first import of the app entry point (see index.js),
 * ahead of `expo-router/entry` and all app code. It wraps React Native's
 * global error handler so that any throw during startup — e.g. a missing
 * native module like the `ExpoLinking` outage of 2026-10-23 — is logged with
 * the `[AIRPLANE_FATAL]` tag (message + JS stack, greppable in logcat) instead
 * of dying silently. The error is then passed to the previous global handler,
 * so React Native's default crash behavior (RedBox in dev, native abort in
 * release) is preserved — nothing is swallowed.
 */

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsShape {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
}

function getErrorUtils(): ErrorUtilsShape | undefined {
  // `ErrorUtils` is a React Native global. Look it up dynamically (instead of
  // relying on ambient types) so this module stays importable in non-RN
  // contexts such as unit tests or web.
  const g = globalThis as unknown as Record<string, unknown>;
  const eu = g['ErrorUtils'] as ErrorUtilsShape | undefined;
  return eu && typeof eu.setGlobalHandler === 'function' ? eu : undefined;
}

const errorUtils = getErrorUtils();

if (errorUtils) {
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error && error.stack ? error.stack : 'n/a';
    // Keep this as console.error: it lands in logcat, which is the only
    // channel available when the JS runtime is dying at startup.
    console.error(`[AIRPLANE_FATAL] isFatal=${String(isFatal)} message=${message}\n${stack}`);
    previousHandler(error, isFatal);
  });
}
