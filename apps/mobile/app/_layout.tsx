import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SplashScreen, Stack } from 'expo-router';
import { ThemeProvider, useTheme } from '../src/theme/themeContext';
import { I18nProvider, useI18n } from '../src/i18n/i18nContext';
import { SettingsProvider } from '../src/lib/settingsContext';
import { DialogHost } from '../components/Dialog/dialogHost';
import { startTransport } from '../services/airplane';

SplashScreen.preventAutoHideAsync().catch(() => {
    /* splash may already be hidden in tests */
});

/** Route-level error boundary: expo-router renders this on uncaught route errors. */
export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
    return (
        <View style={fallbackStyles.center}>
            <Text style={fallbackStyles.title}>Something broke</Text>
            <Text style={fallbackStyles.muted}>{error.message}</Text>
            <Pressable style={fallbackStyles.button} onPress={retry}>
                <Text style={fallbackStyles.buttonText}>Try again</Text>
            </Pressable>
        </View>
    );
}

// The splash stays up until the theme fonts and the saved language are ready,
// so there's no flash of unstyled or wrong-language UI on launch.
function ReadyGate({ children }: { children: React.ReactNode }) {
    const { fontsReady } = useTheme();
    const { languageReady } = useI18n();
    const ready = fontsReady && languageReady;

    useEffect(() => {
        if (ready) SplashScreen.hideAsync().catch(() => {});
    }, [ready]);

    if (!ready) return null;
    return <>{children}</>;
}

export default function RootLayout() {
    useEffect(() => {
        // Start hybrid transport (BLE always, Nostr when online).
        // Failures are non-fatal; the feed works offline regardless.
        startTransport().catch(() => {});
    }, []);

    return (
        <ThemeProvider>
            <I18nProvider>
                <SettingsProvider>
                    <ReadyGate>
                        {/* Screens draw their own chrome (TopBar / SettingsHeader), so no nav headers. */}
                        <Stack screenOptions={{ headerShown: false }}>
                            <Stack.Screen name="index" />
                            <Stack.Screen name="(tabs)" />
                            <Stack.Screen name="post/[id]" />
                        </Stack>
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
