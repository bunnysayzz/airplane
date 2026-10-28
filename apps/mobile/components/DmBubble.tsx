// SPDX-License-Identifier: Apache-2.0
// Memoized DM bubble (audit F5). The bubble reads the theme itself so no
// theme object crosses the memo boundary, and the parent passes a stable
// onRetry: keystrokes in the draft input then re-render only the input row,
// not every bubble. Rendering is identical to the previous inline bubble:
// same layout, colors, text, and Failed retry behavior.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DM_UNDECRYPTABLE_PLACEHOLDER } from '@airplane/transport';
import type { DmThreadRow } from '@airplane/transport';
import { useTheme } from '../src/theme/themeContext';
import { dmBubblePropsEqual } from '../src/lib/dmThread';

export interface DmBubbleProps {
    item: DmThreadRow;
    onRetry: (messageId: string) => void;
}

function DmBubbleInner({ item, onRetry }: DmBubbleProps) {
    const { colors, type } = useTheme();
    return (
        <View style={[styles.bubble, item.direction === 'out' ? styles.out : styles.in, { backgroundColor: item.direction === 'out' ? colors.accentSoft : colors.cardBackground }]}>
            <Text style={{ color: colors.textPrimary }}>{item.text ?? DM_UNDECRYPTABLE_PLACEHOLDER}</Text>
            {item.direction === 'out' ? (
                <Pressable
                    onPress={() => {
                        if (item.status === 'Failed') {
                            onRetry(item.id);
                        }
                    }}
                >
                    <Text style={[type.meta, { color: colors.textMuted }]}>
                        {item.status === 'Failed' ? 'Failed, tap to retry' : item.status}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

export const DmBubble = React.memo(DmBubbleInner, dmBubblePropsEqual);

const styles = StyleSheet.create({
    bubble: { padding: 10, borderRadius: 12, maxWidth: '80%', gap: 2 },
    out: { alignSelf: 'flex-end' },
    in: { alignSelf: 'flex-start' },
});
