import { AccessibilityInfo, Alert, AlertButton } from 'react-native';

// pugdon's own dialogs and toasts, in place of the system Alert. `dialog.alert` takes the same
// arguments as Alert.alert. They draw in the topmost DialogHost (the app root, or an open compose
// sheet, image editor or bottom sheet), never as a Modal of their own: iOS can't present one modal
// over another. With no host (tests, before the app mounts), they fall back to Alert.

export interface DialogButton {
    text: string;
    style?: 'default' | 'cancel' | 'destructive';
    onPress?: () => void;
}

export interface DialogRequest {
    id: number;
    title: string;
    // A line under the title in the text font, for handles, hashtags and names (the display font mangles them)
    subtitle?: string;
    message?: string;
    // Empty means a single OK button
    buttons: DialogButton[];
    // Back and tapping outside cancel it (pressing the cancel button, or calling onDismiss)
    cancelable: boolean;
    onDismiss?: () => void;
}

export interface Toast {
    id: number;
    text: string;
}

interface Host {
    id: number;
    active: boolean;
}

export interface DialogState {
    // Shown one at a time, in order
    dialogs: DialogRequest[];
    toast: Toast | null;
    hosts: Host[];
}

export const TOAST_DURATION_MS = 3000;

let state: DialogState = { dialogs: [], toast: null, hosts: [] };
const listeners = new Set<() => void>();
let nextId = 1;

const set = (next: Partial<DialogState>) => {
    state = { ...state, ...next };
    listeners.forEach(listener => listener());
};

export const getDialogState = () => state;
export const subscribeToDialogs = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

// The host that draws: the last mounted one that's active
export const topHostId = (current: DialogState = state) => [...current.hosts].reverse().find(host => host.active)?.id ?? null;

export const registerHost = (active: boolean) => {
    const id = nextId++;
    set({ hosts: [...state.hosts, { id, active }] });
    return id;
};
export const updateHost = (id: number, active: boolean) =>
    set({ hosts: state.hosts.map(host => (host.id === id ? { ...host, active } : host)) });
export const unregisterHost = (id: number) => set({ hosts: state.hosts.filter(host => host.id !== id) });

const hasHost = () => topHostId() !== null;
const remove = (id: number) => set({ dialogs: state.dialogs.filter(item => item.id !== id) });

export const pressDialogButton = (id: number, button?: DialogButton) => {
    remove(id);
    button?.onPress?.();
};

// Back or a tap outside: like the cancel button, if it can be cancelled at all
export const dismissDialog = (id: number) => {
    const request = state.dialogs.find(item => item.id === id);
    if (!request || !request.cancelable) return;
    remove(id);
    const cancel = request.buttons.find(button => button.style === 'cancel');
    if (cancel) cancel.onPress?.();
    else request.onDismiss?.();
};

export const dialog = {
    alert(...args: [title: string, message?: string, buttons?: DialogButton[], options?: { cancelable?: boolean; onDismiss?: () => void; subtitle?: string }]) {
        const [title, message, buttons, options] = args;
        if (!hasHost()) {
            // Exactly the arguments given, as if Alert had been called directly; a subtitle leads the message
            const { subtitle, ...alertOptions } = options ?? {};
            if (subtitle) {
                Alert.alert(title, message ? `${subtitle}\n\n${message}` : subtitle, buttons as AlertButton[] | undefined, options ? alertOptions : undefined);
                return;
            }
            (Alert.alert as (...alertArgs: unknown[]) => void)(...(args as [string, string?, AlertButton[]?, object?]));
            return;
        }
        // Without a cancel button, only dialogs with a single (OK) button are dismissable by default
        const cancelable = options?.cancelable ?? (!buttons || buttons.length <= 1 || buttons.some(button => button.style === 'cancel'));
        const subtitle = options?.subtitle;
        set({ dialogs: [...state.dialogs, { id: nextId++, title, subtitle, message, buttons: buttons ?? [], cancelable, onDismiss: options?.onDismiss }] });
        AccessibilityInfo.announceForAccessibility([title, subtitle, message].filter(Boolean).join('. '));
    },

    // A short note that goes away by itself: something failed, or something was done
    toast(text: string) {
        if (!hasHost()) {
            Alert.alert(text);
            return;
        }
        const id = nextId++;
        set({ toast: { id, text } });
        AccessibilityInfo.announceForAccessibility(text);
        setTimeout(() => {
            if (state.toast?.id === id) set({ toast: null });
        }, TOAST_DURATION_MS);
    },
};

// For tests: start from nothing
export const resetDialogs = () => set({ dialogs: [], toast: null, hosts: [] });
