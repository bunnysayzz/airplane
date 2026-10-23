// SPDX-License-Identifier: Apache-2.0
// Tests for the AIRPLANE_FATAL startup crash-capture shim (prod-01's fix
// for the `Cannot find native module 'ExpoLinking'` silent-death class).
//
// The shim reads globalThis.ErrorUtils dynamically at import time, so each
// test re-imports the module in an isolated registry with a controlled
// global. Nothing here needs React Native.

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

const SHIM_PATH = '../../src/fatalShim';

function loadShim(): void {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(SHIM_PATH);
  });
}

function installFakeErrorUtils(previous: ErrorHandler): {
  installed: () => ErrorHandler | null;
} {
  let installed: ErrorHandler | null = null;
  (globalThis as unknown as Record<string, unknown>).ErrorUtils = {
    getGlobalHandler: () => previous,
    setGlobalHandler: (h: ErrorHandler) => {
      installed = h;
    },
  };
  return { installed: () => installed };
}

describe('fatalShim', () => {
  const realErrorUtils = (globalThis as Record<string, unknown>).ErrorUtils;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    if (realErrorUtils === undefined) {
      delete (globalThis as Record<string, unknown>).ErrorUtils;
    } else {
      (globalThis as Record<string, unknown>).ErrorUtils = realErrorUtils;
    }
    jest.resetModules();
  });

  test('no ErrorUtils global: importing the shim is a harmless no-op', () => {
    delete (globalThis as Record<string, unknown>).ErrorUtils;
    expect(() => loadShim()).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('ErrorUtils without setGlobalHandler is treated as absent', () => {
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => () => {},
    };
    expect(() => loadShim()).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('installed wrapper logs [AIRPLANE_FATAL] then forwards to the previous handler', () => {
    const previous = jest.fn();
    const { installed } = installFakeErrorUtils(previous);
    loadShim();

    const handler = installed();
    expect(handler).not.toBeNull();

    const err = new Error("Cannot find native module 'ExpoLinking'");
    if (handler) handler(err, true);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = String(consoleErrorSpy.mock.calls[0][0]);
    expect(logged).toContain('[AIRPLANE_FATAL]');
    expect(logged).toContain('isFatal=true');
    expect(logged).toContain("Cannot find native module 'ExpoLinking'");
    expect(logged).toContain('at '); // the JS stack is included for logcat
    // Default crash behavior is preserved: the previous handler still runs.
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(err, true);
  });

  test('non-Error values are stringified and log n/a for the stack', () => {
    const previous = jest.fn();
    const { installed } = installFakeErrorUtils(previous);
    loadShim();

    const handler = installed();
    if (handler) handler('a string blew up', false);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = String(consoleErrorSpy.mock.calls[0][0]);
    expect(logged).toContain('isFatal=false');
    expect(logged).toContain('a string blew up');
    expect(logged).toContain('n/a');
    expect(previous).toHaveBeenCalledWith('a string blew up', false);
  });

  test('Error without a stack logs n/a but still forwards', () => {
    const previous = jest.fn();
    const { installed } = installFakeErrorUtils(previous);
    loadShim();

    const err = new Error('no stack');
    err.stack = undefined as unknown as string;
    const handler = installed();
    if (handler) handler(err, true);

    expect(String(consoleErrorSpy.mock.calls[0][0])).toContain('n/a');
    expect(previous).toHaveBeenCalledWith(err, true);
  });

  test('installing twice keeps a single wrapper around the latest previous handler', () => {
    // Loading the module twice (fresh registries) chains wrappers the way
    // repeated app-entry evaluation would; each wrapper must forward.
    const previous = jest.fn();
    const first = installFakeErrorUtils(previous);
    loadShim();
    const outer = first.installed();

    // Second load sees the first wrapper as the "previous" handler.
    let secondInstalled: ErrorHandler | null = null;
    (globalThis as unknown as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: () => {
        const h = first.installed();
        if (!h) throw new Error('expected first wrapper');
        return h;
      },
      setGlobalHandler: (h: ErrorHandler) => {
        secondInstalled = h;
      },
    };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(SHIM_PATH);
    });

    const err = new Error('chained');
    // secondInstalled is assigned inside the setGlobalHandler closure when
    // the shim module loads a second time. TypeScript cannot observe
    // assignments made inside closures, so read it through an
    // explicitly-typed accessor instead of the narrowed `null`.
    function getSecondInstalled(): ErrorHandler | null {
      return secondInstalled;
    }
    const second = getSecondInstalled();
    if (second && outer) second(err, false);
    expect(previous).toHaveBeenCalledWith(err, false);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2); // both wrappers logged
  });
});
