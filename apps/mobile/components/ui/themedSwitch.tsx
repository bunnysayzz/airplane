import React from 'react';
import { Platform, Switch, SwitchProps } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';
import { recordUiEvent } from '../../services/airplane/diagnostics';

interface ThemedSwitchProps extends Omit<SwitchProps, 'trackColor' | 'ios_backgroundColor' | 'thumbColor'> {
    // Optional log action: when set, a value change logs `<action>:on`
    // or `<action>:off` to the diagnostics log. No log when unset.
    logAction?: string;
}

export const ThemedSwitch: React.FC<ThemedSwitchProps> = ({ logAction, onValueChange, ...rest }) => {
    const { colors } = useTheme();
    return (
        <Switch
            trackColor={{ true: colors.accentColor, false: colors.borderColor }}
            ios_backgroundColor={colors.borderColor}
            // Android paints the thumb in the system accent (teal) unless told; iOS keeps its own white thumb
            thumbColor={Platform.OS === 'android' ? (rest.value ? colors.buttonTextColor : colors.cardBackground) : undefined}
            {...rest}
            onValueChange={(next) => {
                if (logAction !== undefined) recordUiEvent(`${logAction}:${next ? 'on' : 'off'}`);
                onValueChange?.(next);
            }}
        />
    );
};
