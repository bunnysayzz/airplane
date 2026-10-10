import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme/themeContext';
import { hitSlopFor, radii, space } from '../../src/theme/shape';

export interface SegmentOption<T extends string> {
    value: T;
    label: string;
}

interface SegmentedPillProps<T extends string> {
    options: SegmentOption<T>[];
    value: T;
    onChange: (value: T) => void;
    // "segmented" switches views (feeds); "chips" filters a list; "underline" is tabs under a header
    variant?: 'segmented' | 'chips' | 'underline';
}

const CHIP_HEIGHT = 34;

export function SegmentedPill<T extends string>({ options, value, onChange, variant = 'segmented' }: SegmentedPillProps<T>) {
    const { colors, type } = useTheme();

    if (variant === 'chips') {
        return (
            <View style={styles.chips}>
                {options.map(option => {
                    const selected = option.value === value;
                    return (
                        <Pressable
                            key={option.value}
                            onPress={() => onChange(option.value)}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            hitSlop={hitSlopFor(0, CHIP_HEIGHT)}
                            style={[
                                styles.chip,
                                selected
                                    ? { backgroundColor: colors.accentColor, borderColor: colors.accentColor }
                                    : { backgroundColor: colors.cardBackground, borderColor: colors.borderColor },
                            ]}
                        >
                            <Text style={[type.name, styles.chipLabel, { color: selected ? colors.buttonTextColor : colors.textSecondary }]}>
                                {option.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        );
    }

    if (variant === 'underline') {
        return (
            <View accessibilityRole="tablist" style={[styles.underlineRow, { borderBottomColor: colors.borderColor }]}>
                {options.map(option => {
                    const selected = option.value === value;
                    return (
                        <Pressable
                            key={option.value}
                            onPress={() => onChange(option.value)}
                            accessibilityRole="tab"
                            accessibilityState={{ selected }}
                            style={[styles.underlineTab, { borderBottomColor: selected ? colors.accentColor : 'transparent' }]}
                        >
                            <Text style={[type.name, styles.underlineLabel, { color: selected ? colors.textPrimary : colors.textMuted }]}>
                                {option.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        );
    }

    return (
        <View accessibilityRole="tablist" style={[styles.track, { backgroundColor: colors.inputBackground }]}>
            {options.map(option => {
                const selected = option.value === value;
                return (
                    <Pressable
                        key={option.value}
                        onPress={() => onChange(option.value)}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        style={[
                            styles.segment,
                            selected && [styles.segmentSelected, { backgroundColor: colors.cardBackground, shadowColor: colors.shadowColor }],
                        ]}
                    >
                        <Text style={[type.name, styles.segmentLabel, { color: selected ? colors.textPrimary : colors.textMuted }]}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    track: {
        flexDirection: 'row',
        borderRadius: radii.pill,
        padding: 3,
    },
    segment: {
        flex: 1,
        // With the track padding the tab row is 44pt tall
        minHeight: 38,
        borderRadius: radii.pill,
        alignItems: 'center',
        justifyContent: 'center',
    },
    segmentSelected: {
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
        elevation: 1,
    },
    segmentLabel: {
        fontSize: 14,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.sm,
    },
    chip: {
        height: CHIP_HEIGHT,
        paddingHorizontal: 14,
        borderRadius: radii.pill,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
    chipLabel: {
        fontSize: 13,
    },
    underlineRow: {
        flexDirection: 'row',
        gap: space.xl,
        paddingHorizontal: 20,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    underlineTab: {
        minHeight: 44,
        justifyContent: 'center',
        borderBottomWidth: 3,
    },
    underlineLabel: {
        fontSize: 15,
    },
});
