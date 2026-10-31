import React, { useEffect } from 'react';
import { AppState, InteractionManager, Pressable, StyleSheet, Text, View } from 'react-native';
import { SplashScreen, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from '../src/theme/themeContext';
import { I18nProvider, useI18n } from '../src/i18n/i18nContext';
import { SettingsProvider } from '../src/lib/settingsContext';
import { DialogHost } from '../components/Dialog/dialogHost';
import { startTransport, stopTransport, pruneExpiredStore } from '../services/airplane';
import { revalidateBleRadio } from '../services/airplane/transport';
import {
  ensureForegroundRelayRunning,
  syncForegroundRelayState,
} from '../services/airplane/foregroundService';
import { flushDmOutboxIfStarted } from '../services/airplane/dm';
import { checkForUpdateOnLaunch } from '../src/lib/updateCheck';
import { friendlyErrorMessage } from '../src/lib/errorCopy';
import {
  recordDiagnosticsLogAppState,
  startDiagnosticsLogFile,
  stopDiagnosticsLogFile,
} from '../services/airplane/diagnosticsLogExpo';

SplashScreen.preventAutoHideAsync().catch(() => {
    /* splash may already be hidden in tests */
});

/** Route-level error boundary: expo-router renders this on uncaught route errors.
 *  The raw error is never rendered (it could carry a file path, a hex
 *  value, or internals): it goes to the console only, and the screen
 *  shows mapped friendly copy with a generic fallback. */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
    console.error(error);
    return (
        <View style={fallbackStyles.center}>
            <Text style={fallbackStyles.title}>Something broke</Text>
            <Text style={fallbackStyles.muted}>{friendlyErrorMessage(error)}</Text>
            <Pressable style={fallbackStyles.button} onPress={retry}>
                <Text style={fallbackStyles.buttonText}>Try again</Text>
            </Pressable>
        </View>
    );
}

// The splash stays up until the theme fonts and the saved language are ready,
// so there's no flash of unstyled or wrong-language UI on launch.
// The 8s timeout is a safety net: if fonts/storage hang, the app still opens
// instead of wedging on the splash forever.
function ReadyGate({ children }: { children: React.ReactNode }) {
    const { fontsReady } = useTheme();
    const { languageReady } = useI18n();
    const [timedOut, setTimedOut] = React.useState(false);
    const ready = (fontsReady && languageReady) || timedOut;

    useEffect(() => {
        if (ready) SplashScreen.hideAsync().catch(() => {});
    }, [ready]);

    useEffect(() => {
        const t = setTimeout(() => setTimedOut(true), 8000);
        return () => clearTimeout(t);
    }, []);

    if (!ready) return null;
    return <>{children}</>;
}

// Status bar legibility follows the theme (renders inside the ThemeProvider).
function ThemedStatusBar() {
    const { isDark } = useTheme();
    return <StatusBar style={isDark ? 'light' : 'dark'} />;
}

export default function RootLayout() {
    useEffect(() => {
        // LOG: automatic diagnostics logging starts on launch, before
        // transport, with no tap. AppState markers follow below. The
        // background marker is awaited, not fire-and-forget, so the
        // flush gets its grace window; a kill inside that window can
        // still lose the tail (no native background task: not
        // justified for a diagnostics marker).
        void startDiagnosticsLogFile().catch(() => {});
        const appStateSub = AppState.addEventListener('change', async (state) => {
          await recordDiagnosticsLogAppState(state);
          // T4: backgrounding NEVER stops the transport. When the user
          // has background relay on, re-assert the foreground service
          // so the OS keeps the (already running) hybrid transport
          // alive; when it is off, this is a no-op and the transport
          // follows its normal lifecycle. On foreground return, sync
          // the JS service state against the native flag (a service
          // stopped from its notification, or killed, shows as off).
          if (state === 'background' || state === 'inactive') {
            void ensureForegroundRelayRunning().catch(() => {});
          }
          if (state === 'active') {
            void syncForegroundRelayState().catch(() => {});
          }
          // Foreground retention cleanup (best-effort, shared in-flight
          // guard with the startup and sync prunes).
          if (state === 'active') void pruneExpiredStore();
          // Foreground re-validation: a radio toggled off, or an adapter
          // lost while backgrounded, must not keep claiming to be on.
          // revalidateBleRadio itself guards to radios that were on.
          if (state === 'active') void revalidateBleRadio().catch(() => {});
          // P1-09: timers do not reliably fire while backgrounded, so a
          // foreground return also drains the DM outbox (no-op if the DM
          // service was never started, so this never creates subscriptions).
          if (state === 'active') {
            void flushDmOutboxIfStarted().catch(() => {});
          }
        });
        // Start hybrid transport (BLE always, Nostr when online) AFTER first
        // paint so nothing blocks the UI thread during launch. Failures are
        // non-fatal; the feed works offline regardless.
        const task = InteractionManager.runAfterInteractions(() => {
            startTransport().catch(() => {});
        });
        // T14: update check, same deal — after first paint, fire-and-forget.
        // A failed check, no network, or a bad response never breaks launch;
        // the updater module resolves those to "no update" instead of throwing.
        const updateTask = InteractionManager.runAfterInteractions(() => {
            checkForUpdateOnLaunch().catch(() => {});
        });
        return () => {
            appStateSub.remove();
            stopDiagnosticsLogFile();
            task.cancel();
            updateTask.cancel();
            // Root unmount is rare on mobile, but if it happens the NetInfo
            // listener, sync timer and relay sockets must not leak.
            stopTransport().catch(() => {});
        };
    }, []);

    return (
        <ThemeProvider>
            <I18nProvider>
                <SettingsProvider>
                    <ReadyGate>
                        {/* Screens draw their own chrome (TopBar / SettingsHeader), so no nav headers.
                            The boot route is index: first launch runs the Setup/onboarding flow,
                            afterwards it redirects straight to the single feed. */}
                        <Stack screenOptions={{ headerShown: false }}>
                            <Stack.Screen name="index" />
                            <Stack.Screen name="(tabs)" />
                            <Stack.Screen name="post/[id]" />
                        </Stack>
                        <ThemedStatusBar />
                        <DialogHost />
                    </ReadyGate>
                </SettingsProvider>
            </I18nProvider>
        </ThemeProvider>
    );
}

const fallbackStyles = StyleSheet.create({
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        backgroundColor: '#0B0E14',
        padding: 24,
    },
    title: { color: '#E8ECF4', fontSize: 22 },
    muted: { color: '#8A94A6', fontSize: 15, textAlign: 'center' },
    button: {
        backgroundColor: '#4DA3FF',
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 999,
    },
    buttonText: { color: '#0B0E14', fontSize: 15, fontWeight: '700' },
});
