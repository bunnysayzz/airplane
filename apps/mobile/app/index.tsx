import React, { useCallback, useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import Setup from '../screens/Setup/setup';
import { hasCompletedOnboarding } from '../screens/Setup/onboardingStatus';

// First launch shows Setup's explainer (which marks onboarding done on Start);
// afterwards we go straight to the Around feed.
export default function Index() {
    const [checked, setChecked] = useState(false);
    const [showSetup, setShowSetup] = useState(false);

    useEffect(() => {
        let alive = true;
        hasCompletedOnboarding()
            .then(done => {
                if (alive) setShowSetup(!done);
            })
            .catch(() => {
                if (alive) setShowSetup(true);
            })
            .finally(() => {
                if (alive) setChecked(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    // Setup persists the flag itself (markOnboardingDone) before calling onDone.
    const handleDone = useCallback(() => {
        setShowSetup(false);
    }, []);

    if (!checked) return null;
    if (showSetup) return <Setup onDone={handleDone} />;
    return <Redirect href="/(tabs)/around" />;
}
