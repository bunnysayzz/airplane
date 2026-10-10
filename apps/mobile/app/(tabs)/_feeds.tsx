import { useI18n } from '../../src/i18n/i18nContext';
import type { FeedTab } from '../../screens/Timeline/timeline';

// The Around/World pills both feed tabs render. Shared so the two routes and
// the dock stay in sync; labels come from i18n.
export function useFeedTabs(): FeedTab[] {
    const { t } = useI18n();
    return [
        { key: 'around', label: t('timeline.around'), icon: 'radio-outline', activeIcon: 'radio' },
        { key: 'world', label: t('timeline.world'), icon: 'globe-outline', activeIcon: 'globe' },
    ];
}
