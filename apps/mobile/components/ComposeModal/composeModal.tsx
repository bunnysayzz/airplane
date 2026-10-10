import React, { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Keyboard,
    KeyboardAvoidingView,
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
import { PillButton, ThemedSwitch } from '../ui';
import { CharacterCounter } from './characterCounter';
import { useDragToDismiss, useSheetTransition } from './sheetTransition';
import { makeStyles } from './styles';
import { useI18n } from '../../src/i18n/i18nContext';
import { DialogHost } from '../Dialog/dialogHost';
import { dialog } from '../../src/lib/dialog';
import { publishPost } from '../../services/airplane/composer';

// Airplane's post length: the protocol normalizes and caps bodies at 280 chars
export const MAX_POST_LENGTH = 280;

export const keyboardInset = (windowHeight: number, keyboardTop: number) => Math.max(windowHeight - keyboardTop, 0);

const useKeyboard = (windowHeight: number) => {
    const [keyboard, setKeyboard] = useState({ visible: false, inset: 0 });
    useEffect(() => {
        const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', event =>
            setKeyboard({ visible: true, inset: keyboardInset(windowHeight, event.endCoordinates.screenY) })
        );
        const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () =>
            setKeyboard({ visible: false, inset: 0 })
        );
        return () => {
            show.remove();
            hide.remove();
        };
    }, [windowHeight]);
    return keyboard;
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
// design), plus the product's signature control: the opt-in World uplink switch.
// Publishing goes straight to services/airplane's composer (signed mesh post, stored
// locally; the uplink tag is only added when the switch is on).
const ComposeModal: React.FC<ComposeModalProps> = ({ isOpen, onClose, onPublished }) => {
    const { colors, type } = useTheme();
    const { t } = useI18n();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { height: windowHeight } = useWindowDimensions();
    const keyboard = useKeyboard(windowHeight);

    const [text, setText] = useState('');
    const [uplink, setUplink] = useState(false);
    const [loading, setLoading] = useState(false);

    const inputRef = useRef<TextInput>(null);
    const { mounted, progress } = useSheetTransition(isOpen);
    // The text the sheet opened with, to tell whether there's a draft to lose
    const initialText = useRef('');

    // Swiping the sheet down closes it, asking first if there's a draft
    const { drag, panHandlers } = useDragToDismiss(cancel => {
        if (hasDraft({ text, initialText: initialText.current })) {
            dialog.alert(t('compose.discardTitle'), t('compose.discardMessage'), [
                { text: t('compose.keepEditing'), style: 'cancel', onPress: () => cancel() },
                { text: t('compose.discard'), style: 'destructive', onPress: onClose },
            ]);
        } else {
            onClose();
        }
    });

    // Fresh sheet every time it opens; focus the input once the sheet has slid up
    useEffect(() => {
        if (isOpen) {
            setText('');
            setUplink(false);
            setLoading(false);
            initialText.current = '';
            const focus = setTimeout(() => inputRef.current?.focus(), 350);
            return () => clearTimeout(focus);
        }
    }, [isOpen]);

    const remaining = MAX_POST_LENGTH - text.length;
    const isPublishDisabled = text.trim().length === 0 || remaining < 0;

    const handlePublish = async () => {
        if (isPublishDisabled || loading) return;
        setLoading(true);
        try {
            const eventId = await publishPost(text, { uplink });
            dialog.toast(t('compose.posted'));
            onPublished?.(eventId);
            onClose();
        } catch (error: unknown) {
            console.error('Failed to publish post:', error);
            const message = error instanceof Error ? error.message : t('compose.publishFailedMessage');
            dialog.alert(t('compose.publishFailed'), message);
        } finally {
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
            <View collapsable={false} {...panHandlers}>
                <View style={styles.grabberRow} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                    <View style={styles.grabber} />
                </View>

                <View style={styles.header}>
                    <View style={styles.headerSide}>
                        <PillButton label={t('common.cancel')} variant="ghost" onPress={onClose} style={styles.cancel} />
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

                <View style={styles.uplinkRow}>
                    <View style={styles.uplinkText}>
                        <Text style={[type.name, styles.uplinkLabel]}>{t('compose.uplink')}</Text>
                        <Text style={[type.meta, styles.uplinkDetail]}>{t('compose.uplinkDescription')}</Text>
                    </View>
                    <ThemedSwitch value={uplink} onValueChange={setUplink} accessibilityLabel={t('compose.uplink')} />
                </View>
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
        <Modal visible={mounted} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
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
