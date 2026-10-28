import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { IconButton } from '../../components/ui';
import { useTheme } from '../../src/theme/themeContext';
import { space } from '../../src/theme/shape';

interface SettingsHeaderProps {
    title: string;
    onBack: () => void;
    backLabel: string;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({ title, onBack, backLabel }) => {
    const { colors, type } = useTheme();
    return (
        <View style={styles.header}>
            <IconButton icon="arrow-back" accessibilityLabel={backLabel} onPress={onBack} size={24} />
            <Text accessibilityRole="header" style={[type.titleSmall, { color: colors.textPrimary }]}>
                {title}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    header: {
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        paddingHorizontal: space.md,
    },
});
