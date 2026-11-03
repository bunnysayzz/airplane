import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { fromHex, toHex } from '@airplane/protocol';
import { Avatar, Card, SectionLabel } from '../../components/ui';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { SettingsHeader } from './header';
import { makeRelayStyles } from './styles';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useI18n } from '../../src/i18n/i18nContext';
import { dialog } from '../../src/lib/dialog';
import {
  getDevicePublicKey,
  rotateDeviceKey,
} from '../../services/airplane/identity';
import { authorLabelFor, memorableNameFor } from '../../services/airplane/names';
import {
  getOwnDisplayName,
  normalizeDisplayName,
  recordPeerDisplayName,
  setOwnDisplayName,
} from '../../services/airplane/displayNames';
import { recordUiEvent } from '../../services/airplane/diagnostics';

interface IdentityProps {
  onBack: () => void;
}

// Second-level Settings page (same pattern as Relays): shows the device's
// current anonymous identity and offers the T8 burn — replace it with a
// fresh keypair. The consequence is stated on this page AND in the confirm
// dialog, because it cannot be undone: old posts keep the old name, the
// old identity can never post, star, delete or DM again, and the DM
// address changes too (it is derived from the same secret), so old DM
// peers cannot reach the new identity.
const Identity: React.FC<IdentityProps> = ({ onBack }) => {
  const { colors, type } = useTheme();
  const styles = useThemedStyles(makeRelayStyles);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [burning, setBurning] = useState(false);
  const [burnError, setBurnError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getDevicePublicKey()
      .then((pubkey) => {
        setPubkeyHex(toHex(pubkey));
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
    getOwnDisplayName()
      .then((name) => setSavedName(name))
      .catch(() => setSavedName(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setDraft(savedName ?? '');
  }, [savedName]);

  const pubkeyBytes = pubkeyHex ? fromHex(pubkeyHex) : null;
  const label = pubkeyHex ? authorLabelFor(fromHex(pubkeyHex)) : null;
  const cleanName = savedName ?? (pubkeyBytes ? memorableNameFor(pubkeyBytes) : null);

  // DM code copy: one tap copies the FULL pubkey hex (the DM address the
  // Messages tab pastes from). expo-clipboard is autolinked like
  // expo-secure-store (no manual android/ entries, no prebuild); the CI
  // native-module guard fails the build if the module drops from
  // autolinking resolve. The hex stays selectable as a fallback so a
  // long-press copy still works even if the module call ever fails.
  const handleCopy = () => {
    if (pubkeyHex === null) return;
    recordUiEvent('identity:copy-code');
    setCopied(false);
    setCopyFailed(false);
    Clipboard.setStringAsync(pubkeyHex)
      .then(() => setCopied(true))
      .catch(() => setCopyFailed(true));
  };

  const handleSaveName = () => {
    recordUiEvent('identity:display-name-save');
    setNameNote(null);
    setNameError(null);
    if (draft.trim().length === 0) {
      setSavingName(true);
      setOwnDisplayName('')
        .then(() => {
          setSavedName(null);
          setNameNote(t('identity.displayNameCleared'));
          setSavingName(false);
        })
        .catch(() => {
          setSavingName(false);
          setNameError(t('identity.displayNameSaveFailed'));
        });
      return;
    }
    const normalized = normalizeDisplayName(draft);
    if (normalized === null) {
      setNameError(t('identity.displayNameInvalid'));
      return;
    }
    setSavingName(true);
    setOwnDisplayName(normalized)
      .then((saved) => {
        setSavedName(saved);
        if (pubkeyHex && saved) recordPeerDisplayName(pubkeyHex, saved);
        setNameNote(t('identity.displayNameSaved'));
        setSavingName(false);
      })
      .catch(() => {
        setSavingName(false);
        setNameError(t('identity.displayNameSaveFailed'));
      });
  };

  const handleClearName = () => {
    recordUiEvent('identity:display-name-clear');
    setDraft('');
    setNameNote(null);
    setNameError(null);
    setSavingName(true);
    setOwnDisplayName('')
      .then(() => {
        setSavedName(null);
        setNameNote(t('identity.displayNameCleared'));
        setSavingName(false);
      })
      .catch(() => {
        setSavingName(false);
        setNameError(t('identity.displayNameSaveFailed'));
      });
  };

  const handleBurn = () => {
    dialog.alert(t('identity.burnConfirmTitle'), t('identity.burnConfirmMessage'), [
      { text: t('identity.burnCancel'), style: 'cancel' },
      {
        text: t('identity.burnConfirm'),
        style: 'destructive',
        onPress: () => {
          recordUiEvent('identity:burn');
          setBurning(true);
          setBurnError(false);
          rotateDeviceKey()
            .then(async (result) => {
              setPubkeyHex(result.newPublicKeyHex);
              setBurning(false);
              dialog.toast(t('identity.burnDone'));
              // Feed cards cache own-state (starred/reshared by me) against
              // the old pubkey; refresh them for the new identity.
              try {
                const { notifyFeedListeners } = await import(
                  '../../services/airplane/feed'
                );
                notifyFeedListeners();
              } catch {
                // Listeners refresh on next feed load regardless.
              }
            })
            .catch(() => {
              setBurning(false);
              setBurnError(true);
            });
        },
      },
    ]);
  };

  return (
    <>
      <SettingsHeader title={t('identity.title')} onBack={onBack} backLabel={t('appearance.back')} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance(insets.bottom) }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.body, styles.lead]}>{t('identity.lead')}</Text>

        <SectionLabel style={styles.sectionLabel}>{t('identity.current')}</SectionLabel>
        <Card style={styles.group}>
          {loadError ? (
            <Text style={[type.body, styles.empty]}>{t('identity.loadFailed')}</Text>
          ) : label === null ? (
            <Text style={[type.body, styles.empty]}>{t('identity.loading')}</Text>
          ) : (
            <View style={styles.row}>
              <Avatar name={cleanName ?? label} pubkeyHex={pubkeyHex ?? undefined} size={48} />
              <View style={{ flex: 1 }}>
                <Text style={[type.name, styles.rowText]}>{cleanName}</Text>
                <Text style={[type.meta, styles.restartNote]}>{label}</Text>
                <Text style={[type.meta, styles.restartNote]} selectable>{pubkeyHex}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <Pressable
                    style={styles.addButton}
                    onPress={handleCopy}
                    accessibilityRole="button"
                    accessibilityLabel={t('identity.copyCode')}
                  >
                    <Text style={[type.name, styles.addButtonText]}>{t('identity.copyCode')}</Text>
                  </Pressable>
                  {copied && <Text style={[type.meta, styles.restartNote]}>{t('identity.copied')}</Text>}
                </View>
                {copyFailed && <Text style={[type.meta, styles.restartNote]}>{t('identity.copyFailed')}</Text>}
              </View>
            </View>
          )}
        </Card>

        <SectionLabel style={styles.sectionLabel}>{t('identity.displayNameSection')}</SectionLabel>
        <Card style={styles.group}>
          <Text style={[type.body, styles.lead]}>{t('identity.displayNameHint')}</Text>
          <View style={styles.addRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('identity.displayNamePlaceholder')}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={32}
              style={styles.input}
            />
            <Pressable
              style={styles.addButton}
              onPress={handleSaveName}
              disabled={savingName || pubkeyHex === null}
              accessibilityRole="button"
              accessibilityLabel={t('identity.displayNameSave')}
            >
              <Text style={[type.name, styles.addButtonText]}>{t('identity.displayNameSave')}</Text>
            </Pressable>
          </View>
          <View style={styles.addRow}>
            <Pressable
              onPress={handleClearName}
              disabled={savingName || savedName === null}
              accessibilityRole="button"
              accessibilityLabel={t('identity.displayNameClear')}
            >
              <Text style={[type.meta, styles.restartNote]}>{t('identity.displayNameClear')}</Text>
            </Pressable>
          </View>
          {nameNote ? <Text style={[type.meta, styles.restartNote]}>{nameNote}</Text> : null}
          {nameError ? <Text style={[type.meta, styles.restartNote]}>{nameError}</Text> : null}
        </Card>

        <Text style={[type.body, styles.lead]}>{t('identity.consequence')}</Text>
        <Text style={[type.body, styles.lead]}>{t('identity.dmConsequence')}</Text>

        <SectionLabel style={styles.sectionLabel}>{t('identity.burnSection')}</SectionLabel>
        <Card style={styles.group}>
          <Pressable
            style={styles.row}
            onPress={handleBurn}
            disabled={burning || pubkeyHex === null}
            accessibilityRole="button"
            accessibilityLabel={t('identity.burn')}
          >
            <Ionicons name="flame-outline" size={20} color={colors.accentText} />
            <Text style={[type.name, styles.rowText]}>
              {burning ? t('identity.burning') : t('identity.burn')}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </Pressable>
        </Card>
        {burnError && <Text style={[type.meta, styles.restartNote]}>{t('identity.burnFailed')}</Text>}
      </ScrollView>
    </>
  );
};

export default Identity;
