// SPDX-License-Identifier: Apache-2.0
// DM P1 thread view: chronological bubbles, text-only send box, delivery
// states Sending / Sent / Failed (Failed = tap to retry, never silently
// dropped). No read receipts, in either direction. Delete is LOCAL ONLY and
// the confirm copy says so. Requests landing here get Accept / Block / Ignore.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DmConversationRow, DmThreadRow } from '@airplane/transport';
import { DM_UNDECRYPTABLE_PLACEHOLDER } from '@airplane/transport';
import { getDmService, dmPeerLabel, sendDm } from '../../services/airplane/dm';
import { useTheme } from '../../src/theme/themeContext';

export default function DmThreadScreen() {
    const { peer } = useLocalSearchParams<{ peer: string }>();
    const peerHex = (peer ?? '').toLowerCase();
    const insets = useSafeAreaInsets();
    const { colors, type } = useTheme();
    const [thread, setThread] = useState<DmThreadRow[]>([]);
    const [conv, setConv] = useState<DmConversationRow | null>(null);
    const [draft, setDraft] = useState('');

    const refresh = useCallback(() => {
        void getDmService().then(async svc => {
            setThread(await svc.getThread(peerHex));
            const inbox = await svc.listInbox();
            const requests = await svc.listRequests();
            const blocked = await svc.listBlocked();
            setConv([...inbox, ...requests, ...blocked].find(c => c.peerHex === peerHex) ?? null);
        });
    }, [peerHex]);

    useEffect(() => {
        refresh();
        let unsub: (() => void) | undefined;
        void getDmService().then(svc => {
            unsub = svc.subscribe(refresh);
            void svc.markRead(peerHex);
        });
        return () => unsub?.();
    }, [refresh, peerHex]);

    const send = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');
        sendDm(peerHex, text)
            .then(refresh)
            .catch((e: unknown) => Alert.alert('Could not send', e instanceof Error ? e.message : 'Unknown error'));
    };

    const act = (fn: (svc: Awaited<ReturnType<typeof getDmService>>) => Promise<void>): Promise<void> =>
        getDmService()
            .then(svc => fn(svc))
            .then(refresh);

    const confirmDelete = () => {
        Alert.alert(
            'Delete conversation?',
            'This only deletes from your device. The relay copy and the other person\'s copy stay exactly where they are. Unsend is not possible.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () =>
                        act(svc => svc.deleteConversationLocalOnly(peerHex)).then(() => router.back()),
                },
            ],
        );
    };

    const isRequest = conv?.state === 'request';

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <View style={[styles.header, { borderBottomColor: colors.borderColor, paddingTop: insets.top + 16 }]}>
                <Pressable onPress={() => router.back()}>
                    <Text style={[type.meta, { color: colors.accentText }]}>Back</Text>
                </Pressable>
                <Text style={[type.name, { color: colors.textPrimary }]}>{dmPeerLabel(peerHex)}</Text>
                <View style={styles.headerSpacer} />
            </View>

            {isRequest ? (
                <View style={[styles.requestBar, { borderBottomColor: colors.borderColor }]}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Unknown sender. This started in Requests.</Text>
                    <View style={styles.requestRow}>
                        <Pressable onPress={() => act(svc => svc.acceptRequest(peerHex))}>
                            <Text style={[type.meta, { color: colors.accentText }]}>Accept</Text>
                        </Pressable>
                        <Pressable onPress={() => act(svc => svc.blockPeer(peerHex))}>
                            <Text style={[type.meta, { color: colors.accentText }]}>Block</Text>
                        </Pressable>
                        <Pressable onPress={() => act(svc => svc.ignoreRequest(peerHex))}>
                            <Text style={[type.meta, { color: colors.accentText }]}>Ignore</Text>
                        </Pressable>
                    </View>
                </View>
            ) : null}

            <View style={[styles.actions, { borderBottomColor: colors.borderColor }]}>
                <Pressable onPress={() => act(svc => svc.mutePeer(peerHex, !(conv?.muted ?? false)))}>
                    <Text style={[type.meta, { color: colors.accentText }]}>{conv?.muted ? 'Unmute' : 'Mute'}</Text>
                </Pressable>
                <Pressable onPress={() => act(svc => svc.blockPeer(peerHex))}>
                    <Text style={[type.meta, { color: colors.accentText }]}>Block</Text>
                </Pressable>
                <Pressable onPress={confirmDelete}>
                    <Text style={[type.meta, { color: colors.accentText }]}>Delete (this device only)</Text>
                </Pressable>
            </View>

            <FlatList
                data={thread}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.list}
                renderItem={({ item }) => (
                    <View style={[styles.bubble, item.direction === 'out' ? styles.out : styles.in, { backgroundColor: item.direction === 'out' ? colors.accentSoft : colors.cardBackground }]}>
                        <Text style={{ color: colors.textPrimary }}>{item.text ?? DM_UNDECRYPTABLE_PLACEHOLDER}</Text>
                        {item.direction === 'out' ? (
                            <Pressable
                                onPress={() => {
                                    if (item.status === 'Failed') {
                                        void getDmService()
                                            .then(svc => svc.retryMessage(peerHex, item.id))
                                            .then(() => getDmService().then(svc => svc.flushOutbox()))
                                            .then(refresh);
                                    }
                                }}
                            >
                                <Text style={[type.meta, { color: colors.textMuted }]}>
                                    {item.status === 'Failed' ? 'Failed, tap to retry' : item.status}
                                </Text>
                            </Pressable>
                        ) : null}
                    </View>
                )}
            />

            <View style={[styles.sendRow, { borderTopColor: colors.borderColor, paddingBottom: insets.bottom + 12 }]}>
                <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="Message (text only)"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderColor }]}
                />
                <Pressable onPress={send} style={[styles.send, { backgroundColor: colors.accentColor }]}>
                    <Text style={{ color: colors.buttonTextColor }}>Send</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
    headerSpacer: { flex: 1 },
    requestBar: { padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
    requestRow: { flexDirection: 'row', gap: 16 },
    actions: { flexDirection: 'row', gap: 16, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    list: { padding: 16, gap: 8 },
    bubble: { padding: 10, borderRadius: 12, maxWidth: '80%', gap: 2 },
    out: { alignSelf: 'flex-end' },
    in: { alignSelf: 'flex-start' },
    sendRow: { flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10, maxHeight: 120 },
    send: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
});
