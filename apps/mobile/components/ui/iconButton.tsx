import React from 'react';
import { Pressable, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';
import { MIN_TOUCH } from '../../src/theme/shape';
import { recordUiEvent } from '../../services/airplane/diagnostics';

interface IconButtonProps {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    // Required: icon-only controls have no visible text for screen readers
    accessibilityLabel: string;
    onPress: () => void;
    // Optional log action: when set, a real press logs it to the
    // diagnostics log. Pressable disabled still blocks the press.
    logAction?: string;
    size?: number;
    color?: string;
    selected?: boolean;
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
}

export const IconButton: React.FC<IconButtonProps> = ({
    icon,
    accessibilityLabel,
    onPress,
    logAction,
    size = 22,
    color,
    selected,
    disabled = false,
    style,
}) => {
    const { colors } = useTheme();

    return (
        <Pressable
            onPress={() => {
                if (logAction !== undefined) recordUiEvent(logAction);
                onPress();
            }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled, selected }}
            style={({ pressed }) => [styles.button, { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }, style]}
        >
            <Ionicons name={icon} size={size} color={color ?? colors.textPrimary} />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    button: {
        minWidth: MIN_TOUCH,
        minHeight: MIN_TOUCH,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
