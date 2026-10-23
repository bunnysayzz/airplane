// SPDX-License-Identifier: Apache-2.0
// Black-box tests for scripts/check-native-modules.js (the prod-02
// autolinking regression guard). The guard is exercised as a child process
// via spawnSync so coverage and module state never leak between the runner
// and the script under test. All autolink data comes from the script's
// --resolve-json / --rnconfig-json fixture flags; no real autolinking CLI
// is invoked and no network is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-native-modules.js');

/** Build a minimal fake app dir whose entry imports one fake package. */
function makeFixture({ native }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-nativemod-'));
  const appDir = path.join(dir, 'app');
  const pkgDir = path.join(appDir, 'node_modules', 'fake-native-pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'index.js'),
    "require('fake-native-pkg');\nrequire('./local.js');\n"
  );
  fs.writeFileSync(path.join(appDir, 'local.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'fake-native-pkg', version: '1.0.0', main: 'index.js' })
  );
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');
  if (native) {
    const androidDir = path.join(pkgDir, 'android');
    fs.mkdirSync(androidDir, { recursive: true });
    fs.writeFileSync(path.join(androidDir, 'build.gradle'), '// fake native module\n');
  }
  const resolveJson = path.join(dir, 'resolve.json');
  const rnconfigJson = path.join(dir, 'rnconfig.json');
  return { dir, appDir, resolveJson, rnconfigJson };
}

function writeAutolinkFixtures(fixture, { resolveModules, rnDependencies }) {
  fs.writeFileSync(
    fixture.resolveJson,
    JSON.stringify({ modules: resolveModules.map((packageName) => ({ packageName })) })
  );
  const dependencies = {};
  for (const name of rnDependencies) dependencies[name] = {};
  fs.writeFileSync(fixture.rnconfigJson, JSON.stringify({ dependencies }));
}

function runGuard(fixture) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--app-dir',
      fixture.appDir,
      '--resolve-json',
      fixture.resolveJson,
      '--rnconfig-json',
      fixture.rnconfigJson,
    ],
    { encoding: 'utf8' }
  );
}

describe('check-native-modules guard', () => {
  let fixtures = [];

  afterEach(() => {
    for (const f of fixtures) fs.rmSync(f.dir, { recursive: true, force: true });
    fixtures = [];
  });

  function fixture(opts) {
    const f = makeFixture(opts);
    fixtures.push(f);
    return f;
  }

  test('exit 0 when every startup-reachable native package is autolinked', () => {
    const f = fixture({ native: true });
    writeAutolinkFixtures(f, {
      resolveModules: ['fake-native-pkg'],
      rnDependencies: ['some-other-pkg'],
    });
    const r = runGuard(f);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch('OK: every startup-reachable Android native package is autolinked.');
  });

  test('exit 1 names the package missing from autolinking (the expo-linking crash class)', () => {
    const f = fixture({ native: true });
    writeAutolinkFixtures(f, {
      resolveModules: ['unrelated-expo-pkg'],
      rnDependencies: ['unrelated-rn-pkg'],
    });
    const r = runGuard(f);
    expect(r.status).toBe(1);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch('MISSING from autolinking');
    expect(out).toMatch('fake-native-pkg');
  });

  test('a native package listed only in react-native-config still passes', () => {
    const f = fixture({ native: true });
    writeAutolinkFixtures(f, {
      resolveModules: [],
      rnDependencies: ['fake-native-pkg'],
    });
    const r = runGuard(f);
    expect(r.status).toBe(0);
  });

  test('a reachable package with no Android native code is not required to be autolinked', () => {
    const f = fixture({ native: false });
    writeAutolinkFixtures(f, {
      resolveModules: ['some-expo-pkg'],
      rnDependencies: [],
    });
    const r = runGuard(f);
    expect(r.status).toBe(0);
  });

  test('fail-closed: empty union of autolink sources refuses to evaluate', () => {
    const f = fixture({ native: true });
    writeAutolinkFixtures(f, { resolveModules: [], rnDependencies: [] });
    const r = runGuard(f);
    expect(r.status).toBe(1);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch('refusing to evaluate against an empty set');
  });

  test('exit 1 when the app entry point is missing', () => {
    const f = fixture({ native: true });
    writeAutolinkFixtures(f, {
      resolveModules: ['fake-native-pkg'],
      rnDependencies: [],
    });
    fs.rmSync(path.join(f.appDir, 'index.js'));
    const r = runGuard(f);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch('app entry not found');
  });
});
