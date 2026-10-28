import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card, SectionLabel } from '../../components/ui';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { SettingsHeader } from './header';
import { makeDiagnosticsStyles } from './styles';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useI18n } from '../../src/i18n/i18nContext';
import {
  getDiagnosticsSnapshot,
  setDiagnosticsPermissions,
  subscribeDiagnostics,
  type DiagnosticsPeer,
  type DiagnosticsPermissionState,
  type DiagnosticsSnapshot,
} from '../../services/airplane/diagnostics';
import { checkBlePermissionStates } from '../../services/airplane/ble/permissions';
import {
  getDiagnosticsLogStatus,
  shareDiagnosticsLogFile,
} from '../../services/airplane/diagnosticsLogExpo';
import { enableBleRadio } from '../../services/airplane/transport';

interface DiagnosticsProps {
  onBack: () => void;
}

// Second-level Settings page (same pattern as Relays): a scrollable,
// live view of the diagnostics collector. Every value comes from the BLE
// stack or the transport; fields the app cannot observe render as
// unavailable with a plain reason, never as a guessed value.
const Diagnostics: React.FC<DiagnosticsProps> = ({ onBack }) => {
  const { type } = useTheme();
  const styles = useThemedStyles(makeDiagnosticsStyles);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot>(() => getDiagnosticsSnapshot());
  const [logStatus, setLogStatus] = useState(() => getDiagnosticsLogStatus());
  const [shareFailed, setShareFailed] = useState<boolean>(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [retryFailed, setRetryFailed] = useState<boolean>(false);

  const refreshPermissions = () => {
    checkBlePermissionStates()
      .then((report) => {
        setDiagnosticsPermissions({
          scan: report.scan,
          advertise: report.advertise,
          connect: report.connect,
          location: report.location,
          locationServices: report.locationServices,
          batteryOptimisation: report.batteryOptimisation,
          autostart: report.autostart,
        });
      })
      .catch(() => {
        // Permission reads never throw by design; ignore defensively.
      });
  };

  useEffect(() => {
    refreshPermissions();
    const unsub = subscribeDiagnostics(() => setSnapshot(getDiagnosticsSnapshot()));
    // Slower poll, not every second: the throttled subscription drives
    // snapshot updates, and this poll only needs to catch log status
    // changes that arrive without a collector event. Share and focus
    // refresh log status explicitly, so nothing waits on the poll.
    const timer = setInterval(() => {
      setSnapshot(getDiagnosticsSnapshot());
      setLogStatus(getDiagnosticsLogStatus());
    }, 5000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      setSnapshot(getDiagnosticsSnapshot());
      setLogStatus(getDiagnosticsLogStatus());
    }, []),
  );

  const formatTime = (atMs: number | null): string =>
    atMs === null ? t('settings.diagnosticsNever') : new Date(atMs).toLocaleTimeString();

  const formatPermission = (state: DiagnosticsPermissionState): string =>
    state === 'granted'
      ? t('settings.diagnosticsGranted')
      : state === 'denied'
        ? t('settings.diagnosticsDenied')
        : t('settings.diagnosticsUnavailable');

  const formatYesNoUnknown = (value: boolean | null): string =>
    value === null
      ? t('settings.diagnosticsUnknown')
      : value
        ? t('settings.diagnosticsYes')
        : t('settings.diagnosticsNo');

  // File status for the restart-survival check: the loaded count tells
  // the next device run whether the file survived (loaded near the
  // pre-restart count) or reset (loaded near zero), and the write
  // status tells it whether file writes are landing at all.
  const formatLogWriteStatus = (): string => {
    const status =
      logStatus.lastWriteOk === null
        ? t('settings.diagnosticsLogWritePending')
        : logStatus.lastWriteOk
          ? t('settings.diagnosticsLogWriteOk')
          : t('settings.diagnosticsLogWriteFailed');
    const when = logStatus.lastWriteAtMs === null ? '' : ` ${formatTime(logStatus.lastWriteAtMs)}`;
    return `${t('settings.diagnosticsLogWrite', { status })}${when}`;
  };

  const anyDenied =
    snapshot.permissions !== null &&
    (snapshot.permissions.scan === 'denied' ||
      snapshot.permissions.advertise === 'denied' ||
      snapshot.permissions.connect === 'denied' ||
      snapshot.permissions.location === 'denied');

  const permissionRows: {
    label: string;
    state: DiagnosticsPermissionState;
    unavailableNote: boolean;
  }[] = snapshot.permissions
    ? [
        { label: t('settings.diagnosticsPermissionScan'), state: snapshot.permissions.scan, unavailableNote: false },
        { label: t('settings.diagnosticsPermissionAdvertise'), state: snapshot.permissions.advertise, unavailableNote: false },
        { label: t('settings.diagnosticsPermissionConnect'), state: snapshot.permissions.connect, unavailableNote: false },
        { label: t('settings.diagnosticsPermissionLocation'), state: snapshot.permissions.location, unavailableNote: false },
        { label: t('settings.diagnosticsPermissionLocationServices'), state: snapshot.permissions.locationServices, unavailableNote: true },
        { label: t('settings.diagnosticsPermissionBattery'), state: snapshot.permissions.batteryOptimisation, unavailableNote: true },
        { label: t('settings.diagnosticsPermissionAutostart'), state: snapshot.permissions.autostart, unavailableNote: true },
      ]
    : [];

  const renderPeer = (peer: DiagnosticsPeer) => (
    <Card key={peer.peerId} style={styles.peerCard}>
      <Text style={[type.meta, styles.peerId]}>{peer.peerId}</Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsLastSeen')}: {formatTime(peer.lastSeenAtMs)}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsRssi')}: {peer.rssi === null ? t('settings.diagnosticsUnknown') : peer.rssi}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsAdData')}: {peer.advertisementHex ?? t('settings.diagnosticsUnknown')}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsGattState')}: {peer.gattState}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsMtu')}: {peer.mtu === null ? t('settings.diagnosticsUnknown') : peer.mtu}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsCccd')}: {formatYesNoUnknown(peer.cccdSubscribed)}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsPacketsSent')}: {peer.frames.packetsSent}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsPacketsReceived')}: {peer.frames.packetsReceived}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsFragmentsSent')}: {peer.frames.fragmentsSent}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsFragmentsReceived')}: {peer.frames.fragmentsReceived}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsIncompleteSets')}: {peer.frames.incompleteFragmentSets}
      </Text>
      <Text style={[type.body, styles.kvValue]}>
        {t('settings.diagnosticsDedupDrops')}: {peer.frames.dedupDrops}
      </Text>
    </Card>
  );

  return (
    <>
      <SettingsHeader
        title={t('settings.diagnosticsTitle')}
        onBack={onBack}
        backLabel={t('appearance.back')}
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: tabBarClearance(insets.bottom) }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.body, styles.lead]}>{t('settings.diagnosticsLead')}</Text>
        <View style={styles.buttonRow}>
          <Pressable
            style={styles.button}
            onPress={() => {
              refreshPermissions();
              setSnapshot(getDiagnosticsSnapshot());
              setLogStatus(getDiagnosticsLogStatus());
            }}
            accessibilityRole="button"
            accessibilityLabel={t('settings.diagnosticsRefresh')}
          >
            <Text style={[type.name, styles.buttonText]}>{t('settings.diagnosticsRefresh')}</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={() => {
              setShareFailed(false);
              setShareError(null);
              void shareDiagnosticsLogFile()
                .then(() => setLogStatus(getDiagnosticsLogStatus()))
                .catch((error: unknown) => {
                  setShareFailed(true);
                  // Local, owner-visible only: at most a file path, which
                  // the screen already displays. Keeping the message
                  // distinguishes sharing-unavailable from flush
                  // failure from a missing file.
                  setShareError(
                    String(error instanceof Error ? error.message : error)
                      .replace(/[\r\n]+/g, ' ')
                      .trim()
                      .slice(0, 120),
                  );
                });
            }}
            accessibilityRole="button"
            accessibilityLabel={t('settings.diagnosticsShareLog')}
          >
            <Text style={[type.name, styles.buttonText]}>{t('settings.diagnosticsShareLog')}</Text>
          </Pressable>
          {anyDenied && (
            <Pressable
              style={styles.button}
              onPress={() => void Linking.openSettings()}
              accessibilityRole="button"
              accessibilityLabel={t('settings.diagnosticsOpenSettings')}
            >
              <Text style={[type.name, styles.buttonText]}>{t('settings.diagnosticsOpenSettings')}</Text>
            </Pressable>
          )}
          {snapshot.advertising.state === 'stopped' && (
            <Pressable
              style={styles.button}
              onPress={() => {
                // R3: restart the radio from Diagnostics, not only on
                // next launch. enableBleRadio re-requests (a no-op when
                // granted) and brings up advertise + scan; a permanently
                // denied grant returns false and keeps the Open Settings
                // path above, it never loops an OS dialog.
                void enableBleRadio().then((ok) => {
                  refreshPermissions();
                  setSnapshot(getDiagnosticsSnapshot());
                  setRetryFailed(!ok);
                });
              }}
              accessibilityRole="button"
              accessibilityLabel={t('settings.diagnosticsRetryBle')}
            >
              <Text style={[type.name, styles.buttonText]}>{t('settings.diagnosticsRetryBle')}</Text>
            </Pressable>
          )}
        </View>
        {anyDenied && (
          <Text style={[type.meta, styles.note]}>{t('settings.diagnosticsOpenSettingsNote')}</Text>
        )}
        {retryFailed && (
          <Text style={[type.meta, styles.note]}>{t('settings.diagnosticsRetryFailedNote')}</Text>
        )}
        {logStatus.loadOk === null ? (
          <Text style={[type.body, styles.kvValue]}>{t('settings.diagnosticsLogLoading')}</Text>
        ) : (
          <>
            <Text style={[type.body, styles.kvValue]}>{t('settings.diagnosticsLogMemory', { count: logStatus.lineCount })}</Text>
            <Text style={[type.body, styles.kvValue]}>{t('settings.diagnosticsLogOnDisk', { count: logStatus.flushedLineCount })}</Text>
            <Text style={[type.body, styles.kvValue]}>{t('settings.diagnosticsLogLoaded', { count: logStatus.loadedFromFile })}</Text>
          </>
        )}
        <Text style={[type.body, styles.kvValue]}>{formatLogWriteStatus()}</Text>
        {logStatus.loadOk === false && (
          <Text style={[type.meta, styles.note]}>{t('settings.diagnosticsLogLoadFailed')}</Text>
        )}
        {logStatus.lastWriteError !== null && (
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsLogWriteError')}: {logStatus.lastWriteError}
          </Text>
        )}
        <Text style={[type.body, styles.kvValue]}>{t('settings.diagnosticsLogPath', { path: logStatus.fileUri })}</Text>
        <Text style={[type.body, styles.kvValue]}>
          {logStatus.sentryEnabled
            ? t('settings.diagnosticsSentryEnabled')
            : t('settings.diagnosticsSentryDisabled')}
        </Text>
        {shareFailed && (
          <Text style={[type.meta, styles.note]}>
            {t('settings.diagnosticsShareUnavailable')}
            {shareError !== null ? `: ${shareError}` : ''}
          </Text>
        )}

        <SectionLabel style={styles.sectionLabel}>{t('settings.diagnosticsRadio')}</SectionLabel>
        <Card style={styles.group}>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsAdapter')}: {snapshot.adapterState}
          </Text>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsAdvertising')}:{' '}
            {snapshot.advertising.state === 'started'
              ? t('settings.diagnosticsStarted')
              : t('settings.diagnosticsStopped')}
          </Text>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsLastSuccess')}: {formatTime(snapshot.advertising.lastSuccessAtMs)}
          </Text>
          {snapshot.advertising.lastFailure !== null && (
            <Text style={[type.body, styles.kvValue]}>
              {t('settings.diagnosticsLastFailure')}: {snapshot.advertising.lastFailure}
            </Text>
          )}
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsAdLength')}:{' '}
            {snapshot.advertising.advertisementLengthBytes === null
              ? t('settings.diagnosticsUnknown')
              : snapshot.advertising.advertisementLengthBytes}
          </Text>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsScanning')}:{' '}
            {snapshot.scanning.state === 'started'
              ? t('settings.diagnosticsStarted')
              : t('settings.diagnosticsStopped')}
          </Text>
          {snapshot.scanning.lastFailure !== null && (
            <Text style={[type.body, styles.kvValue]}>
              {t('settings.diagnosticsLastFailure')}: {snapshot.scanning.lastFailure}
            </Text>
          )}
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsScanStarts')}: {snapshot.scanning.scanStartsLast30s}
          </Text>
        </Card>

        <SectionLabel style={styles.sectionLabel}>{t('settings.diagnosticsPermissions')}</SectionLabel>
        <Card style={styles.group}>
          {permissionRows.length === 0 ? (
            <Text style={[type.body, styles.empty]}>{t('settings.diagnosticsUnavailable')}</Text>
          ) : (
            permissionRows.map((row) => (
              <View key={row.label}>
                <Text style={[type.body, styles.kvValue]}>
                  {row.label}: {formatPermission(row.state)}
                </Text>
                {row.unavailableNote && row.state === 'unavailable' && (
                  <Text style={[type.meta, styles.note]}>{t('settings.diagnosticsUnavailableNote')}</Text>
                )}
              </View>
            ))
          )}
        </Card>

        <SectionLabel style={styles.sectionLabel}>{t('settings.diagnosticsPeers')}</SectionLabel>
        {snapshot.peers.length === 0 ? (
          <Text style={[type.body, styles.empty]}>{t('settings.diagnosticsPeersEmpty')}</Text>
        ) : (
          snapshot.peers.map(renderPeer)
        )}

        <SectionLabel style={styles.sectionLabel}>{t('settings.diagnosticsFrames')}</SectionLabel>
        <Card style={styles.group}>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsDedupDrops')}: {snapshot.dedupDrops}
          </Text>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsTtlDrops')}: {t('settings.diagnosticsNotTracked')}
          </Text>
          <Text style={[type.meta, styles.note]}>{snapshot.ttlDropsReason}</Text>
          <Text style={[type.body, styles.kvValue]}>
            {t('settings.diagnosticsRelayForwards')}: {t('settings.diagnosticsNotTracked')}
          </Text>
          <Text style={[type.meta, styles.note]}>{snapshot.relayForwardsReason}</Text>
        </Card>

        <SectionLabel style={styles.sectionLabel}>{t('settings.diagnosticsMessages')}</SectionLabel>
        {snapshot.messages.length === 0 ? (
          <Text style={[type.body, styles.empty]}>{t('settings.diagnosticsMessagesEmpty')}</Text>
        ) : (
          snapshot.messages.map((message) => (
            <Card key={`${message.direction}-${message.id}`} style={styles.peerCard}>
              <Text style={[type.meta, styles.peerId]}>{message.id}</Text>
              <Text style={[type.body, styles.kvValue]}>
                {message.direction === 'outbound'
                  ? t('settings.diagnosticsDirectionOutbound')
                  : t('settings.diagnosticsDirectionInbound')}
              </Text>
              <Text style={[type.body, styles.kvValue]}>
                {t('settings.diagnosticsSequence')}:{' '}
                {message.sequence === null
                  ? t('settings.diagnosticsSequencePending')
                  : message.sequence}
              </Text>
              <Text style={[type.body, styles.kvValue]}>
                {t('settings.diagnosticsSize')}: {message.sizeBytes}
              </Text>
              <Text style={[type.body, styles.kvValue]}>
                {t('settings.diagnosticsFinalStatus')}: {message.finalStatus}
              </Text>
              {message.attempts.map((attempt, index) => (
                <Text key={index} style={[type.body, styles.kvValue]}>
                  {attempt.transport} {formatTime(attempt.atMs)} {attempt.outcome}
                  {attempt.detail !== null ? ` (${attempt.detail})` : ''}
                </Text>
              ))}
            </Card>
          ))
        )}
      </ScrollView>
    </>
  );
};

export default Diagnostics;
