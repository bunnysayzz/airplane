import { getSetting, saveSetting } from '../../src/lib/storage';

// Whether the user has finished the onboarding explainer. Setup marks this on Start;
// the navigation worker can use it to decide whether to show onboarding at launch.
const ONBOARDING_DONE_KEY = 'airplane_onboarding_done';

export const hasCompletedOnboarding = () => getSetting(ONBOARDING_DONE_KEY, false);

export const markOnboardingDone = () => saveSetting(ONBOARDING_DONE_KEY, true);
