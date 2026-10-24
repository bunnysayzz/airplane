import React, { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Easing,
    Keyboard,
    KeyboardAvoidingView,
    Linking,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { space } from '../../src/theme/shape';
import { PillButton } from '../ui';
import { CharacterCounter } from './characterCounter';
import { useDragToDismiss, useSheetTransition } from './sheetTransition';
import { makeStyles } from './styles';
import { useI18n } from '../../src/i18n/i18nContext';
import { DialogHost } from '../Dialog/dialogHost';
import { dialog } from '../../src/lib/dialog';
import { publishPost, LocationError } from '../../services/airplane/composer';
import {
    getLocationPermissionStatus,
    requestLocationPermission,
} from '../../services/airplane/location';

// Airplane's post length: the protocol normalizes and caps bodies at 280 chars
export const MAX_POST_LENGTH = 280;

export const keyboardInset = (windowHeight: number, keyboardTop: number) => Math.max(windowHeight - keyboardTop, 0);

const useKeyboard = (windowHeight: number) => {
    const [visible, setVisible] = useState(false);
    const inset = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        const glideTo = (toValue: number, duration: number) =>
            Animated.timing(inset, { toValue, duration, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
        const show = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            event => {
                setVisible(true);
                const target = keyboardInset(windowHeight, event.endCoordinates.screenY);
                // Android's DidShow fires AFTER the keyboard has landed, so glide
                // the sheet instead of jumping; iOS WillShow fires first, so a
                // snap is fine (and KeyboardAvoidingView does the real work).
                if (Platform.OS === 'android') glideTo(target, event.duration || 250);
                else inset.setValue(target);
            }
        );
        const hide = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            event => {
                setVisible(false);
                if (Platform.OS === 'android') glideTo(0, event.duration || 250);
                else inset.setValue(0);
            }
        );
        return () => {
            show.remove();
            hide.remove();
        };
    }, [windowHeight, inset]);
    return { visible, inset };
};

// Anything typed means there's a draft to lose
export const hasDraft = ({ text, initialText }: { text: string; initialText: string }) =>
    text.trim() !== initialText.trim();

interface ComposeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onPublished?: (eventId: string) => void;
}

// Pugdon's compose sheet, stripped for Airplane v1: text only (no media, polls, custom
// emoji, visibility or language pickers - Airplane posts are anonymous and public by
// design). Publishing goes straight to services/airplane's composer (signed post,
// stored locally; relay to World happens silently via hybrid transport).
const ComposeModal: React.FC<ComposeModalProps> = ({ isOpen, onClose, onPublished }) => {
    const { colors, type } = useTheme();
    const { t } = useI18n();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const keyboard = useKeyboard(windowHeight);

    const [text, setText] = useState('');
    const [loading, setLoading] = useState(false);

    const inputRef = useRef<TextInput>(null);
    const { mounted, progress } = useSheetTransition(isOpen);
    // The text the sheet opened with, to tell whether there's a draft to lose
    const initialText = useRef('');

    // Swiping the sheet down closes it, asking first if there's a draft
    const { drag, panHandlers, resetDrag } = useDragToDismiss(cancel => {
        if (hasDraft({ text, initialText: initialText.current })) {
            dialog.alert(t('compose.discardTitle'), t('compose.discardMessage'), [
                { text: t('compose.keepEditing'), style: 'cancel', onPress: () => cancel() },
                {
                    text: t('compose.discard'),
                    style: 'destructive',
                    onPress: () => {
                        resetDrag();
                        onClose();
                    },
                },
            ]);
        } else {
            resetDrag();
            onClose();
        }
    });

    // Cancel and Android-back go through the same discard check as swipe-down,
    // so a draft is never lost silently on any exit path.
    const requestClose = () => {
        if (hasDraft({ text, initialText: initialText.current })) {
            dialog.alert(t('compose.discardTitle'), t('compose.discardMessage'), [
                { text: t('compose.keepEditing'), style: 'cancel' },
                {
                    text: t('compose.discard'),
                    style: 'destructive',
                    onPress: () => {
                        resetDrag();
                        onClose();
                    },
                },
            ]);
        } else {
            resetDrag();
            onClose();
        }
    };

    // Fresh sheet every time it opens; focus the input once the sheet has slid up
    useEffect(() => {
        if (isOpen) {
            setText('');
            setLoading(false);
            initialText.current = '';
            const focus = setTimeout(() => inputRef.current?.focus(), 350);
            return () => clearTimeout(focus);
        }
    }, [isOpen]);

    // The counter and the send gate measure the same thing: trimmed length,
    // so trailing whitespace can't show a false "over".
    const remaining = MAX_POST_LENGTH - text.trim().length;
    const isPublishDisabled = text.trim().length === 0 || remaining < 0;

    // Ref guard against double-submit: setState only lands after re-render,
    // so two taps in one frame could both pass the `loading` check.
    const publishingRef = useRef(false);

    // Permission priming: the OS dialog only ever fires on the user's
    // explicit action. Our own rationale goes first; a denied grant gets
    // clear copy and a one-tap path to Settings — never a dead end, never a
    // repeated OS nag.
    const showLocationDeniedDialog = () => {
        dialog.alert(t('compose.locationDeniedTitle'), t('compose.locationPermissionDenied'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('common.settings'),
                onPress: () => Linking.openSettings(),
            },
        ]);
    };

    const handlePublish = async () => {
        if (isPublishDisabled || loading || publishingRef.current) return;
        publishingRef.current = true;
        setLoading(true);
        try {
            const status = await getLocationPermissionStatus();
            if (status === 'denied') {
                // Already denied: re-firing the OS dialog is a no-op (and on
                // Android a repeated nag), so go straight to the Settings path.
                showLocationDeniedDialog();
                return;
            }
            if (status === 'undetermined') {
                const accepted = await new Promise<boolean>((resolve) => {
                    dialog.alert(
                        t('compose.locationPrePromptTitle'),
                        t('compose.locationPrePromptMessage'),
                        [
                            {
                                text: t('compose.locationNotNow'),
                                style: 'cancel',
                                onPress: () => resolve(false),
                            },
                            {
                                text: t('compose.locationAllow'),
                                onPress: () => resolve(true),
                            },
                        ],
                    );
                });
                if (!accepted) return;
                if (!(await requestLocationPermission())) {
                    // Denied at the OS dialog: same graceful exit, no re-ask.
                    showLocationDeniedDialog();
                    return;
                }
            }
            const eventId = await publishPost(text, {});
            dialog.toast(t('compose.posted'));
            onPublished?.(eventId);
            onClose();
        } catch (error: unknown) {
            console.error('Failed to publish post:', error);
            // Never surface the raw dev error: map known failures to user-facing
            // copy instead. A denied OS permission gets its own copy (it tells
            // the user what to do); every other location failure pauses
            // posting with the generic copy.
            const message =
                error instanceof LocationError
                    ? error.code === 'permission-denied'
                        ? t('compose.locationPermissionDenied')
                        : t('compose.locationPaused')
                    : error instanceof Error && /location/i.test(error.message)
                      ? t('compose.locationPaused')
                      : t('compose.publishFailedMessage');
            dialog.alert(t('compose.publishFailed'), message);
        } finally {
            publishingRef.current = false;
            setLoading(false);
        }
    };

    const translateY = Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }), drag);

    const sheet = (
        <Animated.View
            accessibilityViewIsModal
            style={[styles.sheet, { marginTop: insets.top + space.sm, transform: [{ translateY }] }]}
        >
            {/* The grabber and header are the drag handle. Not collapsable: Android drops views that draw
                nothing, and touches would then land on the sheet behind the handle */}
            <View
                collapsable={false}
                {...panHandlers}
                accessible
                accessibilityRole="adjustable"
                accessibilityLabel={t('compose.dragHandleLabel')}
                accessibilityHint={t('compose.dragHandleHint')}
            >
                <View style={styles.grabberRow} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                    <View style={styles.grabber} />
                </View>

                <View style={styles.header}>
                    <View style={styles.headerSide}>
                        <PillButton label={t('common.cancel')} variant="ghost" onPress={requestClose} style={styles.cancel} />
                    </View>
                    <Text accessibilityRole="header" style={[type.sheetTitle, styles.headerTitle]} numberOfLines={1}>
                        {t('compose.newPost')}
                    </Text>
                    <View style={[styles.headerSide, styles.headerSideEnd]}>
                        <PillButton
                            label={t('compose.post')}
                            onPress={handlePublish}
                            disabled={isPublishDisabled && !loading}
                            loading={loading}
                        />
                    </View>
                </View>
            </View>

            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                <TextInput
                    ref={inputRef}
                    style={[type.body, styles.textArea]}
                    placeholder={t('compose.placeholder')}
                    accessibilityLabel={t('compose.textLabel')}
                    placeholderTextColor={colors.textMuted}
                    multiline
                    value={text}
                    onChangeText={setText}
                    maxLength={MAX_POST_LENGTH + 50}
                />

            </ScrollView>

            <View
                accessibilityRole="toolbar"
                style={[styles.toolbar, { paddingBottom: keyboard.visible ? 10 : Math.max(insets.bottom, 10) }]}
            >
                <View style={styles.toolbarSpacer} />
                <CharacterCounter remaining={remaining} max={MAX_POST_LENGTH} />
            </View>
        </Animated.View>
    );

    // Deviation from pugdon: the Modal unmounts once the close animation finishes
    // (useSheetTransition's `mounted`), instead of staying presented with the sheet parked
    // off-screen - an invisible presented modal would keep swallowing touches.
    return (
        <Modal visible={mounted} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={requestClose}>
            <View style={styles.root}>
                <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim, opacity: progress }]} />
                {/* The app draws edge to edge, so the window doesn't resize for the keyboard. On Android,
                    KeyboardAvoidingView measures against the app window, which ends above the navigation bar,
                    and left a gap that tall under the sheet once the keyboard closed; pad by the keyboard instead. */}
                {Platform.OS === 'ios' ? (
                    <KeyboardAvoidingView behavior="padding" style={styles.keyboardAvoider}>
                        {sheet}
                    </KeyboardAvoidingView>
                ) : (
                    <View style={[styles.keyboardAvoider, { paddingBottom: keyboard.inset }]}>{sheet}</View>
                )}
                <DialogHost active={isOpen} />
            </View>
        </Modal>
    );
};

export default ComposeModal;
