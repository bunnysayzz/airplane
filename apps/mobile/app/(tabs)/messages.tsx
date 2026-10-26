// SPDX-License-Identifier: Apache-2.0
// DM P1 inbox: conversations list, requests folder (default ON), pubkey paste
// to start a conversation, blocked list with unblock. Unread badge total is
// inbox-only (muted excluded, requests shown as their own row).
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DmConversationRow } from '@airplane/transport';
import { DM_UNDECRYPTABLE_PLACEHOLDER } from '@airplane/transport';
import { getDmService, dmPeerLabel } from '../../services/airplane/dm';
import { useTheme } from '../../src/theme/themeContext';

export default function MessagesTab() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors, type } = useTheme();
    const [inbox, setInbox] = useState<DmConversationRow[]>([]);
    const [requests, setRequests] = useState<DmConversationRow[]>([]);
    const [blocked, setBlocked] = useState<DmConversationRow[]>([]);
    const [previews, setPreviews] = useState<Record<string, string | null>>({});
    const [paste, setPaste] = useState('');

    const refresh = useCallback(() => {
        void getDmService().then(async svc => {
            const nextInbox = await svc.listInbox();
            const nextRequests = await svc.listRequests();
            setInbox(nextInbox);
            setRequests(nextRequests);
            setBlocked(await svc.listBlocked());
            const nextPreviews: Record<string, string | null> = {};
            for (const c of [...nextInbox, ...nextRequests]) {
                nextPreviews[c.peerHex] = await svc.previewFor(c.peerHex);
            }
            setPreviews(nextPreviews);
        });
    }, []);

    useFocusEffect(refresh);
    useEffect(() => {
        let unsub: (() => void) | undefined;
        void getDmService().then(svc => {
            unsub = svc.subscribe(refresh);
        });
        return () => unsub?.();
    }, [refresh]);

    const open = (peerHex: string) => router.push(`/dm/${peerHex}`);

    const startFromPaste = () => {
        const key = paste.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(key)) {
            Alert.alert('Not a key', 'Paste a 64-character hex pubkey (or npub support lands in P3).');
            return;
        }
        void getDmService()
            .then(svc => svc.startConversation(key))
            .then(() => {
                setPaste('');
                open(key);
            })
            .catch((e: unknown) => Alert.alert('Could not start conversation', e instanceof Error ? e.message : 'Unknown error'));
    };

    const row = (c: DmConversationRow) => (
        <Pressable
            key={c.peerHex}
            onPress={() => open(c.peerHex)}
            style={[styles.row, { borderBottomColor: colors.borderColor }]}
            accessibilityRole="button"
            accessibilityLabel={`Conversation with ${dmPeerLabel(c.peerHex)}`}
        >
            <Text style={[type.name, { color: colors.textPrimary }]}>{dmPeerLabel(c.peerHex)}</Text>
            <Text style={[type.meta, { color: colors.textMuted }]} numberOfLines={1}>
                {!c.lastSealed ? 'No messages yet' : (previews[c.peerHex] ?? DM_UNDECRYPTABLE_PLACEHOLDER)}
            </Text>
            {c.unread > 0 && !c.muted ? (
                <Text style={[type.meta, { color: colors.accentText }]}>{c.unread} unread</Text>
            ) : null}
            {c.muted ? <Text style={[type.meta, { color: colors.textMuted }]}>Muted</Text> : null}
        </Pressable>
    );

    return (
        <ScrollView
            style={[styles.root, { backgroundColor: colors.background }]}
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
        >
            <Text style={[type.title, { color: colors.textPrimary }]}>Messages</Text>
            <Text style={[type.meta, { color: colors.textMuted }]}>
                Paste a key, or pick someone whose post you saw. No names exist here. Keys are the addresses.
            </Text>
            <View style={styles.pasteRow}>
                <TextInput
                    value={paste}
                    onChangeText={setPaste}
                    placeholder="Paste a pubkey (64 hex chars)"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderColor }]}
                />
                <Pressable onPress={startFromPaste} style={[styles.go, { backgroundColor: colors.accentColor }]}>
                    <Text style={{ color: colors.buttonTextColor }}>Go</Text>
                </Pressable>
            </View>

            {requests.length > 0 ? (
                <>
                    <Text style={[type.name, { color: colors.textPrimary, marginTop: 20 }]}>Requests ({requests.length})</Text>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Unknown senders land here, never straight in your inbox.</Text>
                    {requests.map(row)}
                </>
            ) : null}

            <Text style={[type.name, { color: colors.textPrimary, marginTop: 20 }]}>Inbox</Text>
            {inbox.length === 0 ? <Text style={[type.meta, { color: colors.textMuted }]}>Nothing yet. Message a post author to start.</Text> : inbox.map(row)}

            {blocked.length > 0 ? (
                <>
                    <Text style={[type.name, { color: colors.textPrimary, marginTop: 20 }]}>Blocked</Text>
                    {blocked.map(c => (
                        <View key={c.peerHex} style={[styles.row, { borderBottomColor: colors.borderColor }]}>
                            <Text style={[type.name, { color: colors.textPrimary }]}>{dmPeerLabel(c.peerHex)}</Text>
                            <Pressable
                                onPress={() =>
                                    void getDmService().then(svc => svc.unblockPeer(c.peerHex)).then(refresh)
                                }
                            >
                                <Text style={[type.meta, { color: colors.accentText }]}>Unblock</Text>
                            </Pressable>
                        </View>
                    ))}
                </>
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    content: { padding: 16, paddingBottom: 120 },
    pasteRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10 },
    go: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
    row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
});
