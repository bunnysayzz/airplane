// SPDX-License-Identifier: Apache-2.0
// T4: JS lifecycle tests for the foreground-relay service. The native
// module is faked here; the Kotlin service, notification, and Stop action
// cannot run in Jest and are covered by the CI Android build plus the
// real-device proof list, not by these tests.
import {
  __resetForegroundServiceForTests,
  __setForegroundServiceNativeForTests,
  ensureForegroundRelayRunning,
  getForegroundRelayState,
  isForegroundRelayDesired,
  startForegroundRelay,
  stopForegroundRelay,
  subscribeForegroundRelayState,
  syncForegroundRelayState,
  type ForegroundServiceNative,
} from './foregroundService';

function fakeNative(overrides: Partial<ForegroundServiceNative> = {}): ForegroundServiceNative & {
  start: jest.Mock;
  stop: jest.Mock;
  running: jest.Mock;
} {
  const start = jest.fn(async () => true);
  const stop = jest.fn(async () => true);
  const running = jest.fn(async () => true);
  return {
    startService: start,
    stopService: stop,
    isRunning: running,
    start,
    stop,
    running,
    ...overrides,
  } as unknown as ForegroundServiceNative & {
    start: jest.Mock;
    stop: jest.Mock;
    running: jest.Mock;
  };
}

beforeEach(() => {
  __resetForegroundServiceForTests();
});

test('initial state is disabled and ensure is a no-op when never enabled', async () => {
  const native = fakeNative();
  __setForegroundServiceNativeForTests(native);
  expect(getForegroundRelayState()).toBe('disabled');
  expect(isForegroundRelayDesired()).toBe(false);
  await expect(ensureForegroundRelayRunning()).resolves.toBe(false);
  expect(native.start).not.toHaveBeenCalled();
});

test('no native module means unavailable and start fails without desiring', async () => {
  __setForegroundServiceNativeForTests(null);
  await expect(startForegroundRelay()).resolves.toBe(false);
  expect(getForegroundRelayState()).toBe('unavailable');
  expect(isForegroundRelayDesired()).toBe(false);
});

test('start succeeds, second start is idempotent, stop ends it', async () => {
  const native = fakeNative();
  __setForegroundServiceNativeForTests(native);
  await expect(startForegroundRelay()).resolves.toBe(true);
  expect(getForegroundRelayState()).toBe('running');
  expect(isForegroundRelayDesired()).toBe(true);
  await expect(startForegroundRelay()).resolves.toBe(true);
  expect(native.start).toHaveBeenCalledTimes(1);
  await expect(stopForegroundRelay()).resolves.toBe(true);
  expect(getForegroundRelayState()).toBe('disabled');
  expect(isForegroundRelayDesired()).toBe(false);
  expect(native.stop).toHaveBeenCalledTimes(1);
});

test('native start failure leaves state disabled and desire cleared', async () => {
  const native = fakeNative({ startService: async () => false });
  __setForegroundServiceNativeForTests(native);
  await expect(startForegroundRelay()).resolves.toBe(false);
  expect(getForegroundRelayState()).toBe('disabled');
  expect(isForegroundRelayDesired()).toBe(false);
});

test('native start throwing leaves state disabled', async () => {
  const native = fakeNative({
    startService: async () => {
      throw new Error('boom');
    },
  });
  __setForegroundServiceNativeForTests(native);
  await expect(startForegroundRelay()).resolves.toBe(false);
  expect(getForegroundRelayState()).toBe('disabled');
});

test('subscribers are notified on transitions', async () => {
  const native = fakeNative();
  __setForegroundServiceNativeForTests(native);
  const seen: string[] = [];
  const unsub = subscribeForegroundRelayState(() => seen.push(getForegroundRelayState()));
  await startForegroundRelay();
  await stopForegroundRelay();
  unsub();
  expect(seen).toEqual(['starting', 'running', 'stopping', 'disabled']);
});

test('sync drops to disabled when the native service died, desire stays set', async () => {
  const native = fakeNative();
  __setForegroundServiceNativeForTests(native);
  await startForegroundRelay();
  native.running.mockResolvedValue(false);
  await expect(syncForegroundRelayState()).resolves.toBe('disabled');
  // Desire survives the death: a background transition re-asserts it.
  expect(isForegroundRelayDesired()).toBe(true);
  native.running.mockResolvedValue(true);
  await expect(ensureForegroundRelayRunning()).resolves.toBe(true);
  expect(getForegroundRelayState()).toBe('running');
  expect(native.start).toHaveBeenCalledTimes(2);
});

test('stop during an in-flight start does not flip back to running', async () => {
  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const native = fakeNative({ startService: () => gate });
  __setForegroundServiceNativeForTests(native);
  const started = startForegroundRelay();
  expect(getForegroundRelayState()).toBe('starting');
  await stopForegroundRelay();
  expect(getForegroundRelayState()).toBe('disabled');
  release(true);
  await expect(started).resolves.toBe(true);
  expect(getForegroundRelayState()).toBe('disabled');
  expect(isForegroundRelayDesired()).toBe(false);
});
