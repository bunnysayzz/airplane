import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, PanResponder } from 'react-native';

// Drives a sheet's open/close: progress goes 0 → 1 (backdrop opacity, sheet slide),
// and the sheet stays mounted until it has slid away
export const useSheetTransition = (open: boolean) => {
    const [mounted, setMounted] = useState(open);
    const progress = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (open) {
            setMounted(true);
            Animated.timing(progress, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
        } else {
            Animated.timing(progress, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true })
                .start(({ finished }) => finished && setMounted(false));
        }
    }, [open, progress]);

    return { mounted, progress };
};

// A drag past this distance (or a quick flick down) dismisses the sheet
export const DISMISS_DISTANCE = 120;
export const DISMISS_VELOCITY = 1;

export const shouldDismiss = (dy: number, vy: number) => dy > DISMISS_DISTANCE || (dy > 0 && vy > DISMISS_VELOCITY);

// Lets the user drag a sheet down by its handle. `drag` follows the finger (never above 0);
// past the threshold onDismiss runs (it can call `cancel` to spring back instead), otherwise the sheet springs back.
export const useDragToDismiss = (onDismiss: (cancel: () => void) => void) => {
    const drag = useRef(new Animated.Value(0)).current;
    const dismiss = useRef(onDismiss);
    dismiss.current = onDismiss;

    const springBack = () => Animated.spring(drag, { toValue: 0, bounciness: 4, useNativeDriver: true }).start();

    const panHandlers = useRef(
        PanResponder.create({
            // Claim touches that start on the handle itself: waiting for a move lets a view higher up claim
            // the touch first, and then the handle is never asked. Buttons inside the handle are deeper, so
            // they still get their taps; drags that start on them are taken over once they clearly go down.
            onStartShouldSetPanResponder: () => true,
            // Hold on to the drag once it has started
            onPanResponderTerminationRequest: () => false,
            onMoveShouldSetPanResponder: (_, { dx, dy }) => dy > 8 && Math.abs(dy) > Math.abs(dx),
            onPanResponderMove: (_, { dy }) => drag.setValue(Math.max(dy, 0)),
            onPanResponderRelease: (_, { dy, vy }) => {
                if (shouldDismiss(dy, vy)) {
                    dismiss.current(springBack);
                } else {
                    springBack();
                }
            },
            onPanResponderTerminate: springBack,
        })
    ).current.panHandlers;

    return { drag, panHandlers };
};
