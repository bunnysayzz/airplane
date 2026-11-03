// SPDX-License-Identifier: Apache-2.0
// Saved thread: a conversation with yourself, stored on this device only.
// This screen deliberately reuses the DM thread layout (chronological
// list, input row, auto scroll to the latest note) but NOT the DM send
// machinery: there is no peer, no outbox and no delivery state to show,
// because a saved note is never published to a relay, never sent over
// Bluetooth and never handed to any reshare path. Saving writes to the
// local only SelfMessageStore and nothing else. Delete is a local delete:
// these notes exist nowhere else, so deleting here deletes them entirely.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSelfMessageStore, type SelfMessage } from '../../services/airplane/selfMessages';
import { isNearBottom } from '../../src/lib/dmThread';
import { recordUiEvent } from '../../services/airplane/diagnostics';
import { RouteTracker } from '../../components/RouteTracker/routeTracker';
import { useTheme } from '../../src/theme/themeContext';

export default function SavedThreadScreen() {
    const insets = useSafeAreaInsets();
    const { colors, type } = useTheme();
    const [notes, setNotes] = useState<SelfMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const [refreshError, setRefreshError] = useState(false);

    const listRef = useRef<FlatList<SelfMessage>>(null);
    const nearBottomRef = useRef(true);
    const initialScrollDoneRef = useRef(false);
    const handleListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        nearBottomRef.current = isNearBottom({
            contentHeight: contentSize.height,
            offsetY: contentOffset.y,
            viewportHeight: layoutMeasurement.height,
        });
    }, []);
    const handleListContentSizeChange = useCallback(() => {
        if (!initialScrollDoneRef.current) {
            initialScrollDoneRef.current = true;
            listRef.current?.scrollToEnd({ animated: false });
        } else if (nearBottomRef.current) {
            listRef.current?.scrollToEnd({ animated: true });
        }
    }, []);

    const refresh = useCallback(() => {
        return getSelfMessageStore()
            .list()
            .then(list => {
                setNotes(list);
                setRefreshError(false);
            })
            .catch(() => {
                setRefreshError(true);
            });
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const save = () => {
        const text = draft.trim();
        if (!text || saving) return;
        setSaving(true);
        recordUiEvent('self:save');
        getSelfMessageStore()
            .save(text)
            .then(() => {
                setDraft('');
                setSaving(false);
                void refresh();
            })
            .catch(() => {
                setSaving(false);
                Alert.alert('Could not save', 'That note was not saved. Try again.');
            });
    };

    const remove = useCallback((id: string) => {
        recordUiEvent('self:delete');
        getSelfMessageStore()
            .delete(id)
            .then(() => refresh())
            .catch(() => Alert.alert('Action failed', 'That note was not deleted. Try again.'));
    }, [refresh]);

    const confirmDeleteAll = () => {
        Alert.alert(
            'Delete all saved notes?',
            'This deletes every saved note from this device. Saved notes exist nowhere else, so this cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete all',
                    style: 'destructive',
                    onPress: () => {
                        recordUiEvent('self:delete-all');
                        getSelfMessageStore()
                            .deleteAll()
                            .then(() => refresh())
                            .catch(() => Alert.alert('Action failed', 'Saved notes were not deleted. Try again.'));
                    },
                },
            ],
        );
    };

    const renderItem = useCallback(
        ({ item }: { item: SelfMessage }) => (
            <View style={[styles.bubble, { backgroundColor: colors.accentSoft }]}>
                <Text style={{ color: colors.textPrimary }}>{item.text}</Text>
                <Pressable onPress={() => remove(item.id)}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Delete</Text>
                </Pressable>
            </View>
        ),
        [colors, type, remove],
    );

    return (
        <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <RouteTracker />
            <View style={[styles.header, { borderBottomColor: colors.borderColor, paddingTop: insets.top + 16 }]}>
                <Pressable onPress={() => router.back()}>
                    <Text style={[type.meta, { color: colors.accentText }]}>Back</Text>
                </Pressable>
                <Text style={[type.name, { color: colors.textPrimary }]}>Saved</Text>
                <View style={styles.headerSpacer} />
            </View>

            <View style={[styles.banner, { borderBottomColor: colors.borderColor }]}>
                <Text style={[type.meta, { color: colors.textMuted }]}>
                    This device only. Never sent to anyone. No relay, no Bluetooth, and no delivery status, because nothing here is ever sent.
                </Text>
            </View>

            <View style={[styles.actions, { borderBottomColor: colors.borderColor }]}>
                <Pressable
                    style={[styles.actionButton, { backgroundColor: colors.dangerColor }]}
                    onPress={confirmDeleteAll}
                >
                    <Text style={[type.name, { color: colors.buttonTextColor }]}>Delete all (this device only)</Text>
                </Pressable>
            </View>

            {refreshError ? (
                <View style={[styles.banner, { borderBottomColor: colors.borderColor }]}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Could not load saved notes.</Text>
                    <Pressable
                        onPress={() => {
                            recordUiEvent('self:retry-load');
                            void refresh();
                        }}
                    >
                        <Text style={[type.meta, { color: colors.accentText }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : null}

            {notes.length === 0 && !refreshError ? (
                <View style={styles.list}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Nothing saved yet. Notes you save here stay on this phone only.</Text>
                </View>
            ) : null}

            <FlatList
                ref={listRef}
                data={notes}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.list}
                onScroll={handleListScroll}
                scrollEventThrottle={100}
                onContentSizeChange={handleListContentSizeChange}
                renderItem={renderItem}
                keyboardShouldPersistTaps="handled"
            />

            <View style={[styles.saveRow, { borderTopColor: colors.borderColor, paddingBottom: insets.bottom + 12 }]}>
                <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Save a note for yourself"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderColor }]}
                />
                <Pressable onPress={save} disabled={saving} style={[styles.save, { backgroundColor: colors.accentColor }]}>
                    <Text style={{ color: colors.buttonTextColor }}>Save</Text>
                </Pressable>
            </View>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
    headerSpacer: { flex: 1 },
    banner: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
    actions: { flexDirection: 'row', gap: 16, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexWrap: 'wrap' },
    actionButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
    list: { padding: 16, gap: 8 },
    bubble: { padding: 10, borderRadius: 12, maxWidth: '80%', alignSelf: 'flex-end', gap: 2 },
    saveRow: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, maxHeight: 120 },
    save: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
});
