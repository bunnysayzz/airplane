import React, { useEffect } from 'react';
import { Animated, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { space } from '../../src/theme/shape';
import { makeStyles } from './styles';
import { useDragToDismiss, useSheetTransition } from './sheetTransition';
import { useI18n } from '../../src/i18n/i18nContext';
import { DialogHost } from '../Dialog/dialogHost';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface BottomSheetProps {
    visible: boolean;
    title: string;
    // A line under the title in the text font, for things like handles that look wrong in the display font
    subtitle?: string;
    onClose: () => void;
    children: React.ReactNode;
}

// A small sheet over the compose sheet, for pickers
export const BottomSheet: React.FC<BottomSheetProps> = ({ visible, title, subtitle, onClose, children }) => {
    const { type } = useTheme();
    const { t } = useI18n();
    const styles = useThemedStyles(makeStyles);
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    // The backdrop fades while only the sheet slides; a sliding Modal would carry the backdrop up like a curtain
    const { mounted, progress } = useSheetTransition(visible);
    const { drag, panHandlers } = useDragToDismiss(onClose);

    useEffect(() => {
        if (visible) drag.setValue(0);
    }, [visible, drag]);

    const translateY = Animated.add(progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), drag);

    return (
        <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
            <View style={styles.sheetRoot}>
                {/* A sibling of the sheet, not its parent: an accessible parent would hide the options from screen readers */}
                <AnimatedPressable
                    style={[styles.sheetBackdrop, { opacity: progress }]}
                    onPress={onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                />
                <Animated.View style={[styles.pickerSheet, { paddingBottom: insets.bottom + space.lg, transform: [{ translateY }] }]}>
                    <View collapsable={false} {...panHandlers}>
                        <View style={styles.grabberRow}>
                            <View style={styles.grabber} />
                        </View>
                        <Text accessibilityRole="header" style={[type.sheetTitle, styles.pickerTitle, !!subtitle && styles.pickerTitleWithSubtitle]}>
                            {title}
                        </Text>
                        {!!subtitle && <Text style={[type.meta, styles.pickerSubtitle]} numberOfLines={1}>{subtitle}</Text>}
                    </View>
                    {children}
                </Animated.View>
                <DialogHost active={visible} />
            </View>
        </Modal>
    );
};

export interface SheetOption<T extends string | number> {
    value: T;
    label: string;
    description?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
}

interface OptionSheetProps<T extends string | number> {
    visible: boolean;
    title: string;
    options: SheetOption<T>[];
    value: T;
    onSelect: (value: T) => void;
    onClose: () => void;
}

// Picks one value and closes
export function OptionSheet<T extends string | number>({ visible, title, options, value, onSelect, onClose }: OptionSheetProps<T>) {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);

    return (
        <BottomSheet visible={visible} title={title} onClose={onClose}>
            <ScrollView accessibilityRole="radiogroup" bounces={false}>
                {options.map(option => {
                    const selected = option.value === value;
                    return (
                        <Pressable
                            key={option.value}
                            onPress={() => {
                                onSelect(option.value);
                                onClose();
                            }}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: selected }}
                            accessibilityLabel={option.description ? `${option.label}, ${option.description}` : option.label}
                            style={({ pressed }) => [styles.option, (selected || pressed) && styles.optionSelected]}
                        >
                            {option.icon && <Ionicons name={option.icon} size={20} color={colors.accentText} />}
                            <View style={styles.optionText}>
                                <Text style={[type.name, styles.optionLabel]}>{option.label}</Text>
                                {option.description && <Text style={[type.meta, styles.optionDescription]}>{option.description}</Text>}
                            </View>
                            {selected && <Ionicons name="checkmark" size={18} color={colors.accentText} />}
                        </Pressable>
                    );
                })}
            </ScrollView>
        </BottomSheet>
    );
}

export interface SheetAction {
    key: string;
    label: string;
    description?: string;
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    // Shown, but can't be picked; the description says why
    disabled?: boolean;
    onPress: () => void;
}

interface ActionSheetProps {
    visible: boolean;
    title: string;
    subtitle?: string;
    actions: SheetAction[];
    onClose: () => void;
}

// A short list of things to do; picking one closes the sheet first
export function ActionSheet({ visible, title, subtitle, actions, onClose }: ActionSheetProps) {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);

    return (
        <BottomSheet visible={visible} title={title} subtitle={subtitle} onClose={onClose}>
            {actions.map(action => (
                <Pressable
                    key={action.key}
                    onPress={() => {
                        onClose();
                        action.onPress();
                    }}
                    disabled={action.disabled}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    accessibilityHint={action.description}
                    accessibilityState={{ disabled: !!action.disabled }}
                    style={({ pressed }) => [styles.option, pressed && styles.optionSelected, action.disabled && { opacity: 0.5 }]}
                >
                    {action.icon && <Ionicons name={action.icon} size={20} color={action.disabled ? colors.textMuted : colors.accentText} />}
                    <View style={styles.optionText}>
                        <Text style={[type.name, styles.optionLabel]}>{action.label}</Text>
                        {action.description && <Text style={[type.meta, styles.optionDescription]}>{action.description}</Text>}
                    </View>
                </Pressable>
            ))}
        </BottomSheet>
    );
}
