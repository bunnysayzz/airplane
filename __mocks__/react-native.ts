// SPDX-License-Identifier: Apache-2.0
// Minimal react-native mock for the mobile-services jest project. Only the
// surfaces our services touch: Platform, PermissionsAndroid, NativeModules,
// NativeEventEmitter, AppState (react-native-mmkv's Jest mock subscribes
// to memoryWarning on construction). Tests override behavior via
// jest.replaceProperty or the exported __set helpers.

type Listener = (...args: unknown[]) => void;

class FakeEventEmitter {
  static instances: FakeEventEmitter[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor() {
    FakeEventEmitter.instances.push(this);
  }
  addListener(event: string, cb: Listener): { remove: () => void } {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return {
      remove: () => {
        this.listeners.get(event)?.delete(cb);
      },
    };
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  removeAllListeners(event?: string): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
}

export const Platform = {
  OS: 'android' as string,
  Version: 34 as number | string,
  select: <T,>(spec: { android?: T; native?: T; default?: T }): T | undefined =>
    spec.android ?? spec.native ?? spec.default,
};

export const PermissionsAndroid = {
  PERMISSIONS: {
    BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
    BLUETOOTH_ADVERTISE: 'android.permission.BLUETOOTH_ADVERTISE',
    BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
    ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
  } as Record<string, string>,
  RESULTS: {
    GRANTED: 'granted',
    DENIED: 'denied',
    NEVER_ASK_AGAIN: 'never_ask_again',
  } as Record<string, string>,
  request: jest.fn(async (): Promise<string> => 'granted'),
  check: jest.fn(async (): Promise<boolean> => true),
};

export const NativeModules = {
  // Intentionally empty: no native modules exist in jest. BLE library
  // requires therefore fail closed (null adapters) unless a test provides
  // jest.mock factories for the native modules.
};

export const NativeEventEmitter = FakeEventEmitter;

export const AppState = {
  currentState: 'active' as string,
  addEventListener: (_type: string, _cb: Listener): { remove: () => void } => ({
    remove: () => {},
  }),
};

/** Reset mock state between tests. */
export function __resetReactNativeMock(): void {
  Platform.OS = 'android';
  Platform.Version = 34;
  FakeEventEmitter.instances.length = 0;
  PermissionsAndroid.request.mockReset();
  PermissionsAndroid.request.mockResolvedValue('granted');
  PermissionsAndroid.check.mockReset();
  PermissionsAndroid.check.mockResolvedValue(true);
}
