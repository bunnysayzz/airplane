import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme/themeContext';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { IconButton, PugMark, logoSizes } from '../ui';
import { MeshStatus } from '../MeshStatus';
import { makeStyles } from './styles';
import { useI18n } from '../../src/i18n/i18nContext';

interface TopBarProps {
    onSettingsPress: () => void;
}

// Pugdon's top bar with the account menu stripped: Airplane is anonymous, so there
// is no avatar, no profile and no logout - just the wordmark and settings.
export const TopBar: React.FC<TopBarProps> = ({ onSettingsPress }) => {
    const { colors, type, coat } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { t } = useI18n();

    return (
        <SafeAreaView edges={['top']} style={styles.safeArea}>
            <View style={styles.container}>
                <View style={styles.wordmark} accessible accessibilityRole="header" accessibilityLabel="airplane">
                    <PugMark coat={coat} size={logoSizes.wordmark} />
                    <Text style={[type.title, styles.wordmarkText]}>airplane</Text>
                </View>

                <View style={styles.rightCluster}>
                    {/* Mesh + relay status lives here: glanceable from every feed tab */}
                    <MeshStatus />
                    <IconButton icon="options-outline" accessibilityLabel={t('common.settings')} onPress={onSettingsPress} color={colors.textSecondary} size={24} style={styles.settingsButton} />
                </View>
            </View>
        </SafeAreaView>
    );
};
