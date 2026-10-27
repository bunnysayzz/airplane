import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { makeStyles } from './styles';
import { useI18n } from '../../src/i18n/i18nContext';

// Under this many characters left, the counter warns
export const NEAR_LIMIT = 20;

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2 - 1.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export const counterState = (remaining: number) =>
    remaining < 0 ? 'over' : remaining < NEAR_LIMIT ? 'near' : 'plenty';

interface CharacterCounterProps {
    remaining: number;
    max: number;
}

// A ring that fills as you type: accent, then accent ink near the limit, then danger with "N over"
export const CharacterCounter: React.FC<CharacterCounterProps> = ({ remaining, max }) => {
    const { colors, type } = useTheme();
    const { t } = useI18n();
    const styles = useThemedStyles(makeStyles);
    const state = counterState(remaining);
    const color = { plenty: colors.accentColor, near: colors.accentText, over: colors.dangerColor }[state];
    const textColor = { plenty: colors.textMuted, near: colors.accentText, over: colors.dangerColor }[state];
    const used = Math.min(1, Math.max(0, (max - remaining) / max));

    return (
        <View
            accessible
            accessibilityLabel={state === 'over' ? t('compose.charactersOver', { count: -remaining }) : t('compose.charactersLeft', { count: remaining })}
            style={styles.counter}
        >
            <Text style={[type.name, styles.counterText, { color: textColor }]}>
                {state === 'over' ? t('compose.overShort', { count: -remaining }) : remaining}
            </Text>
            <Svg testID="character-ring" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
                <Circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={state === 'over' ? color : colors.borderColor} strokeWidth={STROKE} />
                {state !== 'over' && used > 0 && (
                    <Circle
                        cx={SIZE / 2}
                        cy={SIZE / 2}
                        r={RADIUS}
                        fill="none"
                        stroke={color}
                        strokeWidth={STROKE}
                        strokeLinecap="round"
                        strokeDasharray={`${used * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                    />
                )}
            </Svg>
        </View>
    );
};
