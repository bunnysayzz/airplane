import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, BackHandler, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/themeContext';
import { useI18n } from '../../src/i18n/i18nContext';
import {
    DialogButton,
    dismissDialog,
    getDialogState,
    pressDialogButton,
    registerHost,
    subscribeToDialogs,
    topHostId,
    unregisterHost,
    updateHost,
} from '../../src/lib/dialog';
import { radii, space } from '../../src/theme/shape';
import { tabBarClearance } from '../TabBar/styles';
import { PillButton } from '../ui';

interface DialogHostProps {
    // Inactive hosts (a sheet that's closing) leave dialogs to the host below
    active?: boolean;
}

const variantFor = (button: DialogButton, firstDefault: boolean) =>
    button.style === 'destructive' ? 'danger' : button.style === 'cancel' ? 'ghost' : firstDefault ? 'primary' : 'secondary';

const CARD_MAX_WIDTH = 360;
const PILL_PADDING = 18;
// ponytail: an average glyph width for the 14pt pill label, not a measurement; measure the pills with onLayout if labels overflow
const LABEL_CHAR_WIDTH = 7.5;

// Side by side when every label fits on one row of the card at this screen width, else stacked
export const stackButtons = (labels: string[], windowWidth: number) => {
    if (labels.length > 2) return true;
    const rowWidth = Math.min(windowWidth - space.xl * 2, CARD_MAX_WIDTH) - space.xl * 2;
    const needed = labels.reduce((width, label) => width + label.length * LABEL_CHAR_WIDTH + PILL_PADDING * 2, 0) + space.sm * (labels.length - 1);
    return needed > rowWidth;
};

// Draws Airplane's dialogs and toasts over whatever it's placed in (see src/lib/dialog.ts). One sits at
// the app root; compose, the image editor and every bottom sheet have their own, so dialogs show above them.
export const DialogHost: React.FC<DialogHostProps> = ({ active = true }) => {
    const { colors, type } = useTheme();
    const { t } = useI18n();
    const { width } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    // Registered from an effect (not during render), so a render that's thrown away leaves nothing behind
    const [hostId, setHostId] = useState<number | null>(null);
    const state = useSyncExternalStore(subscribeToDialogs, getDialogState, getDialogState);
    const top = hostId !== null && topHostId(state) === hostId;
    const current = top ? state.dialogs[0] : undefined;
    const toast = top ? state.toast : null;
    const appear = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const registered = registerHost(active);
        setHostId(registered);
        return () => unregisterHost(registered);
        // Registered once; `active` changes are passed on via the effect below.
    }, []);
    useEffect(() => {
        if (hostId !== null) updateHost(hostId, active);
    }, [hostId, active]);

    // Each dialog fades and grows in
    useEffect(() => {
        if (!current) return;
        appear.setValue(0);
        Animated.timing(appear, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    }, [current?.id, appear]);

    // Android's back button cancels it, like tapping outside
    useEffect(() => {
        if (!current) return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            dismissDialog(current.id);
            return true;
        });
        return () => subscription.remove();
    }, [current?.id]);

    if (!current && !toast) return null;

    const buttons: DialogButton[] = current?.buttons.length ? current.buttons : [{ text: t('common.ok') }];
    // Cancel first (on the left, or at the bottom when stacked), like the platforms do
    const ordered = [...buttons.filter(button => button.style === 'cancel'), ...buttons.filter(button => button.style !== 'cancel')];
    const firstDefault = ordered.find(button => button.style !== 'cancel' && button.style !== 'destructive');
    const stacked = stackButtons(ordered.map(button => button.text), width);

    return (
        <View style={StyleSheet.absoluteFill} pointerEvents={current ? 'auto' : 'box-none'}>
            {current && (
                <>
                    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: appear }]}>
                        <Pressable
                            style={StyleSheet.absoluteFill}
                            onPress={() => dismissDialog(current.id)}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.close')}
                            importantForAccessibility="no"
                            accessibilityElementsHidden
                        />
                    </Animated.View>
                    <View style={styles.center} pointerEvents="box-none">
                        <Animated.View
                            accessibilityViewIsModal
                            testID="dialog"
                            style={[
                                styles.card,
                                { backgroundColor: colors.cardBackground, borderColor: colors.borderColor },
                                { opacity: appear, transform: [{ scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] },
                            ]}
                        >
                            <View style={styles.heading}>
                                <Text accessibilityRole="header" style={[type.sheetTitle, { color: colors.textPrimary }]}>{current.title}</Text>
                                {!!current.subtitle && (
                                    <Text style={[type.name, { color: colors.textSecondary }]} numberOfLines={2}>{current.subtitle}</Text>
                                )}
                            </View>
                            {!!current.message && <Text style={[type.body, { color: colors.textSecondary }]}>{current.message}</Text>}
                            <View style={[styles.buttons, stacked && styles.buttonsStacked]}>
                                {(stacked ? [...ordered].reverse() : ordered).map((button, index) => (
                                    <PillButton
                                        key={`${button.text}-${index}`}
                                        label={button.text}
                                        variant={variantFor(button, button === firstDefault)}
                                        onPress={() => pressDialogButton(current.id, button)}
                                        style={stacked ? styles.buttonStacked : undefined}
                                    />
                                ))}
                            </View>
                        </Animated.View>
                    </View>
                </>
            )}
            {toast && (
                <View pointerEvents="none" style={[styles.toastRow, { bottom: tabBarClearance(insets.bottom) }]}>
                    <View
                        testID="toast"
                        accessibilityLiveRegion="polite"
                        style={[styles.toast, { backgroundColor: colors.textPrimary }]}
                    >
                        <Text style={[type.name, { color: colors.background }]}>{toast.text}</Text>
                    </View>
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    center: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xl,
    },
    card: {
        width: '100%',
        maxWidth: CARD_MAX_WIDTH,
        gap: space.md,
        padding: space.xl,
        borderRadius: radii.card,
        borderWidth: StyleSheet.hairlineWidth,
    },
    heading: {
        gap: 2,
    },
    buttons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
        gap: space.sm,
        marginTop: space.xs,
    },
    buttonsStacked: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    buttonStacked: {
        alignSelf: 'stretch',
    },
    // Above the dock (bottom offset applied by the component - it tracks the dock's live inset)
    toastRow: {
        position: 'absolute',
        left: space.lg,
        right: space.lg,
        alignItems: 'center',
    },
    toast: {
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderRadius: radii.pill,
        maxWidth: 480,
    },
});
