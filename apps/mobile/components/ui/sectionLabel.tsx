import React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';

interface SectionLabelProps {
    children: React.ReactNode;
    style?: StyleProp<TextStyle>;
}

export const SectionLabel: React.FC<SectionLabelProps> = ({ children, style }) => {
    const { colors, type } = useTheme();
    return (
        <Text accessibilityRole="header" style={[type.label, { color: colors.textMuted }, style]}>
            {children}
        </Text>
    );
};
