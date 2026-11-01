// SPDX-License-Identifier: Apache-2.0
// Route transition logger: mount once per route screen. Only the
// focused screen's effect is active, so each transition logs exactly
// once: a forward line on push, a back line on pop, with static
// screen names only. Tab switches log a nav line alongside the tab
// tap line (both true: the tap happened and the transition happened).
// Hardware back and header back both produce route transitions, so
// both are covered here with no per-button wiring.
import { useCallback } from 'react';
import { useFocusEffect, useSegments } from 'expo-router';
import { observeRoutePath } from '../../services/airplane/routeTracker';
import { recordUiNavigation } from '../../services/airplane/diagnostics';

export function RouteTracker(): null {
    const segments = useSegments();
    const path = `/${segments.join('/')}`;
    useFocusEffect(
        useCallback(() => {
            const event = observeRoutePath(path);
            if (event !== null) recordUiNavigation(event.direction, event.screen);
        }, [path]),
    );
    return null;
}
