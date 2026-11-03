// SPDX-License-Identifier: Apache-2.0
// DM P1 inbox: conversations list, requests folder (default ON), username
// search over known peers plus pubkey paste to start a conversation, blocked list with unblock. Each row carries its
// own unread count pill (requests too; a muted row keeps its preserved
// count). The tab total is inbox-only (muted excluded, requests
// excluded): requests carry their own row pills instead.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DmConversationRow } from '@airplane/transport';
import { DM_UNDECRYPTABLE_PLACEHOLDER } from '@airplane/transport';
import { getDmService, dmPeerLabel, dmUserErrorMessage } from '../../services/airplane/dm';
import {
    hydratePeerDisplayNames,
    knownPeerHexes,
    matchKnownPeers,
    resolvePeerNames,
} from '../../services/airplane/displayNames';
import { Avatar } from '../../components/ui';
import { unreadPillText } from '../../components/TabBar/tabBar';
import { getSelfMessageStore } from '../../services/airplane/selfMessages';
import { useTheme } from '../../src/theme/themeContext';
import { recordUiEvent } from '../../services/airplane/diagnostics';
import { RouteTracker } from '../../components/RouteTracker/routeTracker';

export default function MessagesTab() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { colors, type } = useTheme();
    const [inbox, setInbox] = useState<DmConversationRow[]>([]);
    const [requests, setRequests] = useState<DmConversationRow[]>([]);
    const [blocked, setBlocked] = useState<DmConversationRow[]>([]);
    const [previews, setPreviews] = useState<Record<string, string | null>>({});
    const [query, setQuery] = useState('');
    const [savedCount, setSavedCount] = useState(0);
    // A failed refresh used to leave stale lists with no error shown. Now
    // refresh is all-or-nothing (lists + previews set only on success) and
    // a failure shows a retry affordance instead of silent staleness.
    const [refreshError, setRefreshError] = useState(false);

    const refresh = useCallback(() => {
        void (async () => {
            // Hydrate first: the registry holds display names learned from
            // feed posts, which is what makes username search and clean
            // DM list names work after a restart.
            await hydratePeerDisplayNames();
            try {
                const svc = await getDmService();
                const nextInbox = await svc.listInbox();
                const nextRequests = await svc.listRequests();
                const nextBlocked = await svc.listBlocked();
                const convs = [...nextInbox, ...nextRequests];
                // Previews used to load one conversation at a time (each a
                // potential decrypt); one parallel batch instead.
                const previewValues = await Promise.all(convs.map(c => svc.previewFor(c.peerHex)));
                const nextPreviews: Record<string, string | null> = {};
                convs.forEach((c, i) => {
                    nextPreviews[c.peerHex] = previewValues[i];
                });
                setInbox(nextInbox);
                setRequests(nextRequests);
                setBlocked(nextBlocked);
                setPreviews(nextPreviews);
                // Saved notes load separately: a self store failure must
                // never fail the whole DM refresh or hide conversations.
                try {
                    const saved = await getSelfMessageStore().list();
                    setSavedCount(saved.length);
                } catch {
                    setSavedCount(0);
                }
                setRefreshError(false);
            } catch {
                setRefreshError(true);
            }
        })();
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

    // Candidate peers for username search: conversation contacts plus
    // every peer whose signed display name this device recorded from a
    // post. A peer never seen cannot resolve by name (no directory
    // exists); the hex path below stays as the fallback for that case.
    const allPeerHexes = useMemo(() => {
        const hexes = new Set<string>();
        for (const c of [...inbox, ...requests, ...blocked]) hexes.add(c.peerHex.toLowerCase());
        for (const hex of knownPeerHexes()) hexes.add(hex);
        return [...hexes];
    }, [inbox, requests, blocked]);
    const peerNames = useMemo(() => resolvePeerNames(allPeerHexes), [allPeerHexes]);
    const peerNameFor = (peerHex: string) => peerNames.get(peerHex.toLowerCase()) ?? dmPeerLabel(peerHex);

    const queryTrim = query.trim();
    const queryIsHex = /^[0-9a-f]{64}$/i.test(queryTrim);
    const matches = useMemo(() => {
        if (!queryTrim || queryIsHex) return [];
        return matchKnownPeers(queryTrim, allPeerHexes);
    }, [queryTrim, queryIsHex, allPeerHexes]);

    const startFromInput = () => {
        const key = query.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(key)) {
            Alert.alert('Not a key', 'Paste a 64-character hex pubkey, or tap a matching username below.');
            return;
        }
        void getDmService()
            .then(svc => svc.startConversation(key))
            .then(() => {
                setQuery('');
                open(key);
            })
            .catch((e: unknown) => Alert.alert('Could not start conversation', dmUserErrorMessage(e)));
    };

    const startFromMatch = (peerHex: string) => {
        recordUiEvent('dm:start-username');
        void getDmService()
            .then(svc => svc.startConversation(peerHex))
            .then(() => {
                setQuery('');
                open(peerHex);
            })
            .catch((e: unknown) => Alert.alert('Could not start conversation', dmUserErrorMessage(e)));
    };

    const row = (c: DmConversationRow) => (
        <Pressable
            key={c.peerHex}
            onPress={() => {
                recordUiEvent('dm:open', c.peerHex);
                open(c.peerHex);
            }}
            style={[styles.row, { borderBottomColor: colors.borderColor }]}
            accessibilityRole="button"
            accessibilityLabel={
                c.unread > 0
                    ? `Conversation with ${peerNameFor(c.peerHex)}, ${c.unread} unread`
                    : `Conversation with ${peerNameFor(c.peerHex)}`
            }
        >
            <Avatar name={peerNameFor(c.peerHex)} pubkeyHex={c.peerHex} size={36} />
            <View style={{ flex: 1, gap: 2 }}>
                <Text style={[type.name, { color: colors.textPrimary }]}>{peerNameFor(c.peerHex)}</Text>
                <Text style={[type.meta, { color: colors.textMuted }]} numberOfLines={1}>
                    {!c.lastSealed ? 'No messages yet' : (previews[c.peerHex] ?? DM_UNDECRYPTABLE_PLACEHOLDER)}
                </Text>
                {c.muted ? <Text style={[type.meta, { color: colors.textMuted }]}>Muted</Text> : null}
            </View>
            {c.unread > 0 ? (
                <View style={[styles.unreadPill, { backgroundColor: colors.accentColor }]}>
                    <Text style={[styles.unreadPillText, { color: colors.buttonTextColor }]}>{unreadPillText(c.unread)}</Text>
                </View>
            ) : null}
        </Pressable>
    );

    return (
        <>
            <RouteTracker />
            <ScrollView
            style={[styles.root, { backgroundColor: colors.background }]}
            contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}
        >
            <Text style={[type.title, { color: colors.textPrimary }]}>Messages</Text>
            <Text style={[type.meta, { color: colors.textMuted }]}>
                Type a username to message someone you have seen post or messaged before, or paste a key for anyone else. There is no directory: unseen peers cannot be found by name.
            </Text>
            <Text style={[type.meta, { color: colors.textMuted }]}>
                DMs go over relays and Bluetooth mesh, and this device keeps them across restarts.
            </Text>
            <View style={styles.pasteRow}>
                <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Username or pubkey (64 hex chars)"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.input, { color: colors.textPrimary, borderColor: colors.borderColor }]}
                />
                <Pressable onPress={() => {
                    recordUiEvent('dm:start-paste');
                    startFromInput();
                }} disabled={!queryIsHex} hitSlop={8} style={[styles.go, { backgroundColor: colors.accentColor }, !queryIsHex && styles.goDisabled]}>
                    <Text style={{ color: colors.buttonTextColor }}>Go</Text>
                </Pressable>
            </View>

            {queryTrim && !queryIsHex ? (
                matches.length > 0 ? (
                    <View style={{ marginTop: 12, gap: 2 }}>
                        {matches.map(m => (
                            <Pressable
                                key={m.pubkeyHex}
                                onPress={() => startFromMatch(m.pubkeyHex)}
                                style={[styles.row, { borderBottomColor: colors.borderColor }]}
                                accessibilityRole="button"
                                accessibilityLabel={`Message ${m.name}`}
                            >
                                <Avatar name={m.name} pubkeyHex={m.pubkeyHex} size={36} />
                                <View style={{ flex: 1, gap: 2 }}>
                                    <Text style={[type.name, { color: colors.textPrimary }]}>{m.name}</Text>
                                    <Text style={[type.meta, { color: colors.textMuted }]}>Tap to message</Text>
                                </View>
                            </Pressable>
                        ))}
                    </View>
                ) : (
                    <Text style={[type.meta, { color: colors.textMuted, marginTop: 12 }]}>
                        No known peer matches that name. Paste their full key above to start anyway.
                    </Text>
                )
            ) : null}

            {refreshError ? (
                <View style={styles.retryRow}>
                    <Text style={[type.meta, { color: colors.textMuted }]}>Could not refresh conversations.</Text>
                    <Pressable onPress={() => {
                        recordUiEvent('dm:retry-load');
                        refresh();
                    }} accessibilityRole="button" accessibilityLabel="Retry loading conversations">
                        <Text style={[type.meta, { color: colors.accentText }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : null}

            <Text style={[type.name, { color: colors.textPrimary, marginTop: 20 }]}>Saved</Text>
            <Pressable
                onPress={() => {
                    recordUiEvent('self:open');
                    router.push('/dm/self');
                }}
                style={[styles.row, { borderBottomColor: colors.borderColor }]}
                accessibilityRole="button"
                accessibilityLabel="Saved messages, this device only"
            >
                <Text style={[type.name, { color: colors.textPrimary }]}>Saved</Text>
                <Text style={[type.meta, { color: colors.textMuted }]} numberOfLines={1}>
                    This device only. Never sent to anyone.
                </Text>
                <Text style={[type.meta, { color: colors.textMuted }]}>
                    {savedCount === 0 ? 'No saved notes yet' : `${savedCount} saved ${savedCount === 1 ? 'note' : 'notes'}`}
                </Text>
            </Pressable>

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
                            <Avatar name={peerNameFor(c.peerHex)} pubkeyHex={c.peerHex} size={36} />
                            <Text style={[type.name, { color: colors.textPrimary, flex: 1 }]}>{peerNameFor(c.peerHex)}</Text>
                            <Pressable
                                onPress={() => {
                                    recordUiEvent('dm:unblock', c.peerHex);
                                    void getDmService()
                                        .then(svc => svc.unblockPeer(c.peerHex))
                                        .then(refresh)
                                        .catch((e: unknown) => Alert.alert('Action failed', dmUserErrorMessage(e)))
                                }}
                            >
                                <Text style={[type.meta, { color: colors.accentText }]}>Unblock</Text>
                            </Pressable>
                        </View>
                    ))}
                </>
            ) : null}
            </ScrollView>
        </>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    content: { padding: 16, paddingBottom: 120 },
    pasteRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    retryRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
    input: { flex: 1, borderWidth: 1, borderRadius: 8, padding: 10 },
    go: { borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
    goDisabled: { opacity: 0.5 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
    unreadPill: {
        minWidth: 22,
        height: 22,
        paddingHorizontal: 6,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unreadPillText: {
        fontSize: 12,
        fontWeight: '700',
    },
});
