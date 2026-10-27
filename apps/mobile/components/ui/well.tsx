import React from 'react';
import { StyleSheet, View, ViewProps } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';
import { radii, space } from '../../src/theme/shape';

// Sunken panel inside a card for featured content: polls, link previews, quoted snippets
export const Well: React.FC<ViewProps> = ({ style, ...props }) => {
    const { colors } = useTheme();
    return <View style={[styles.well, { backgroundColor: colors.inputBackground }, style]} {...props} />;
};

const styles = StyleSheet.create({
    well: {
        borderRadius: radii.well,
        padding: space.md,
    },
});
