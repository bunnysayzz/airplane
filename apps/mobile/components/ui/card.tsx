import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';
import { radii } from '../../src/theme/shape';

export const Card: React.FC<ViewProps> = ({ style, ...props }) => {
    const { colors, isDark } = useTheme();
    return (
        <View
            style={[
                styles.card,
                { backgroundColor: colors.cardBackground, borderColor: colors.borderColor },
                // Shadows read as smudges on dark grounds, so only light mode gets one
                !isDark && [styles.shadow, { shadowColor: colors.shadowColor }],
                style,
            ]}
            {...props}
        />
    );
};

const styles = StyleSheet.create({
    card: {
        borderRadius: radii.card,
        borderWidth: StyleSheet.hairlineWidth,
    },
    shadow: {
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
        elevation: 1,
    },
});
