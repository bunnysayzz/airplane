import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { fromHex, toHex } from '@airplane/protocol';
import { Card, SectionLabel } from '../../components/ui';
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
import { authorLabelFor } from '../../services/airplane/names';

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

  const refresh = useCallback(() => {
    getDevicePublicKey()
      .then((pubkey) => {
        setPubkeyHex(toHex(pubkey));
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const label = pubkeyHex ? authorLabelFor(fromHex(pubkeyHex)) : null;

  const handleBurn = () => {
    dialog.alert(t('identity.burnConfirmTitle'), t('identity.burnConfirmMessage'), [
      { text: t('identity.burnCancel'), style: 'cancel' },
      {
        text: t('identity.burnConfirm'),
        style: 'destructive',
        onPress: () => {
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
              <Ionicons name="key-outline" size={20} color={colors.accentText} />
              <View style={{ flex: 1 }}>
                <Text style={[type.name, styles.rowText]}>{label}</Text>
                <Text style={[type.meta, styles.restartNote]}>{pubkeyHex}</Text>
              </View>
            </View>
          )}
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
