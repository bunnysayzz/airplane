/**
 * Crash reporting bootstrap.
 *
 * IMPORTANT: this module must be imported FIRST in app/_layout.tsx, before
 * every other app import. ES imports evaluate in order, so anything imported
 * before this module (theme, i18n, transport, ...) would throw before
 * Sentry.init runs — and the launch crash we're hunting is exactly an
 * import-time throw during bundle evaluation.
 *
 * DSN comes from EXPO_PUBLIC_SENTRY_DSN at build time. When it's missing
 * (local dev without the var, builds without the SENTRY_DSN secret) the
 * SDK stays disabled instead of crashing.
 */
import * as Sentry from '@sentry/react-native';

Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    enableNative: true,
    // Captures crashes during JS bundle load (before React mounts) as well as
    // native crashes routed through the native layer armed via useNativeInit.
    enableNativeCrashHandling: true,
});

export default Sentry;
