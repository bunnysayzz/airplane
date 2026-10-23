import React, { useCallback, useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import Setup from '../screens/Setup/setup';
import { hasCompletedOnboarding } from '../screens/Setup/onboardingStatus';
import { getDeviceKeypair } from '../services/airplane/identity';

// First launch: Setup's boot splash runs real boot work (load-or-generate the
// stable Ed25519 device identity, which also warms the keystore cache so the
// first signed post is fast), then shows the one-time explainer. The explainer
// marks onboarding done itself (markOnboardingDone) before calling onDone.
// Afterwards we go straight to the single feed. Boot failures are non-fatal:
// the splash timeout/skip still advances, and signing paths load-or-generate
// lazily anyway.
export default function Index() {
    const [checked, setChecked] = useState(false);
    const [showSetup, setShowSetup] = useState(false);
    const [identityReady, setIdentityReady] = useState(false);

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
        getDeviceKeypair()
            .then(() => {
                if (alive) setIdentityReady(true);
            })
            .catch(error => {
                console.error('Failed to load device identity at boot:', error);
                // Still advance: the splash must never wedge on a keystore error
                if (alive) setIdentityReady(true);
            });
        return () => {
            alive = false;
        };
    }, []);

    const handleDone = useCallback(() => {
        setShowSetup(false);
    }, []);

    if (!checked) return null;
    if (showSetup) return <Setup onDone={handleDone} ready={identityReady} />;
    return <Redirect href="/(tabs)/feed" />;
}
