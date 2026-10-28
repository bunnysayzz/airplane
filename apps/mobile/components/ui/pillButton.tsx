import React from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../../src/theme/themeContext';
import { hitSlopFor, radii } from '../../src/theme/shape';

interface PillButtonProps {
    label: string;
    onPress: () => void;
    // danger: for destructive choices (delete, block)
    variant?: 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger';
    size?: 'small' | 'medium';
    icon?: React.ComponentProps<typeof Ionicons>['name'];
    loading?: boolean;
    disabled?: boolean;
    style?: StyleProp<ViewStyle>;
}

const HEIGHTS = { small: 34, medium: 38 } as const;

export const PillButton: React.FC<PillButtonProps> = ({
    label,
    onPress,
    variant = 'primary',
    size = 'medium',
    icon,
    loading = false,
    disabled = false,
    style,
}) => {
    const { colors, type } = useTheme();
    const height = HEIGHTS[size];
    const inactive = disabled || loading;

    const palette = {
        primary: { background: colors.accentColor, border: colors.accentColor, text: colors.buttonTextColor },
        secondary: { background: colors.cardBackground, border: colors.borderColor, text: colors.textPrimary },
        subtle: { background: colors.inputBackground, border: colors.inputBackground, text: colors.textSecondary },
        ghost: { background: 'transparent', border: 'transparent', text: colors.accentText },
        danger: { background: colors.dangerColor, border: colors.dangerColor, text: colors.cardBackground },
    }[variant];

    return (
        <Pressable
            onPress={onPress}
            disabled={inactive}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: inactive, busy: loading }}
            hitSlop={hitSlopFor(0, height)}
            style={({ pressed }) => [
                styles.button,
                {
                    height,
                    paddingHorizontal: size === 'small' ? 14 : 18,
                    backgroundColor: palette.background,
                    borderColor: palette.border,
                    opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
                },
                style,
            ]}
        >
            {/* Keep the label in place while loading so the button doesn't change width */}
            <View style={[styles.content, loading && styles.hidden]}>
                {icon && <Ionicons name={icon} size={size === 'small' ? 15 : 17} color={palette.text} />}
                <Text style={[type.name, { fontSize: size === 'small' ? 13 : 14, color: palette.text }]}>{label}</Text>
            </View>
            {loading && <ActivityIndicator style={StyleSheet.absoluteFill} size="small" color={palette.text} />}
        </Pressable>
    );
};

const styles = StyleSheet.create({
    button: {
        borderRadius: radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
    content: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    hidden: {
        opacity: 0,
    },
});
