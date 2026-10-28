import React from 'react';
import { Platform, Switch, SwitchProps } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';

export const ThemedSwitch: React.FC<Omit<SwitchProps, 'trackColor' | 'ios_backgroundColor' | 'thumbColor'>> = props => {
    const { colors } = useTheme();
    return (
        <Switch
            trackColor={{ true: colors.accentColor, false: colors.borderColor }}
            ios_backgroundColor={colors.borderColor}
            // Android paints the thumb in the system accent (teal) unless told; iOS keeps its own white thumb
            thumbColor={Platform.OS === 'android' ? (props.value ? colors.buttonTextColor : colors.cardBackground) : undefined}
            {...props}
        />
    );
};
