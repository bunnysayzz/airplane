// SPDX-License-Identifier: Apache-2.0
/**
 * check-native-modules.js — regression guard for the "required but not
 * autolinked native module" crash class (2026-10-23: `Cannot find native
 * module 'ExpoLinking'` at startup -> JniException -> SIGABRT).
 *
 * What it checks: every package that (a) is reachable from the app entry
 * point via static import/require edges and (b) ships an Android native
 * module (android/build.gradle or an expo-module.config.json declaring the
 * android platform) MUST be listed by
 * `expo-modules-autolinking react-native-config -p android --json` — the
 * exact command `apps/mobile/android/settings.gradle` feeds to
 * `autolinkLibrariesFromCommand` (via `expoAutolinking.rnConfigCommand`).
 * NOTE: the `resolve` subcommand is NOT sufficient ground truth — it only
 * covers expo-module.config.json packages and misses react-native.config.js
 * (RN CLI) modules like react-native-screens. If a package is required at
 * startup but dropped by autolinking (e.g. expo-linking was only a peer dep
 * of expo-router, so filterToProjectDependenciesAsync skipped it), this
 * script fails BEFORE the Gradle build, instead of dying silently on the
 * device.
 *
 * Usage:
 *   node scripts/check-native-modules.js [--app-dir apps/mobile]
 *       [--autolink-json <file>]   # override: use a captured
 *                                  # react-native-config JSON instead of
 *                                  # invoking the CLI (fixture mode)
 *
 * Exit 0: every startup-reachable native package is autolinked.
 * Exit 1: at least one is missing (names printed); or the check itself failed.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const REPO_ROOT = process.cwd();
const APP_DIR = path.resolve(REPO_ROOT, opt('--app-dir', 'apps/mobile'));
const AUTOLINK_JSON = opt('--autolink-json', null);

const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\sfrom\s+)?|export\s+[^'"]*?\sfrom\s+|require\(\s*|import\(\s*)(['"])([^'"]+)\1/g;
const RELATIVE_RE = /^\.{1,2}\//;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Resolve a bare specifier from an importing file, honouring hoisted node_modules. */
function resolvePackageDir(spec, fromFile) {
  let dir = path.dirname(fromFile);
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  while (true) {
    const cand = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(cand)) return path.dirname(cand);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveRelative(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`];
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  for (const c of cands) {
    const idx = ['index.js', 'index.ts', 'index.tsx'].map((f) => path.join(c, f));
    for (const f of idx) if (fs.existsSync(f)) return f;
  }
  // package main entry
  const pkgJson = path.join(base, 'package.json');
  if (fs.existsSync(pkgJson)) {
    const main = readJson(pkgJson).main || 'index.js';
    const f = path.resolve(base, main);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function packageNameForFile(file) {
  const rel = path.relative(REPO_ROOT, file);
  const m = rel.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return m ? m[1] : null;
}

/** Walk the static import graph from the app entry; return Map<packageName, installDir>. */
function reachablePackages(entryFile) {
  const seen = new Set();
  const pkgs = new Map();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const pkg = packageNameForFile(file);
    if (pkg && !pkgs.has(pkg)) {
      const dir = resolvePackageDir(pkg, file);
      if (dir) pkgs.set(pkg, dir);
    }
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[2];
      if (RELATIVE_RE.test(spec)) {
        const f = resolveRelative(spec, file);
        if (f) stack.push(f);
      } else if (!spec.startsWith('.') && !path.isAbsolute(spec)) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        const dir = resolvePackageDir(name, file);
        if (!dir) continue;
        if (!pkgs.has(name)) pkgs.set(name, dir);
        // Resolve the actually-imported subpath (e.g. `expo-router/entry`),
        // not just the package main — the subpath may pull in more modules.
        const sub = spec.slice(name.length).replace(/^\//, '');
        let f = null;
        if (sub) {
          f = resolveRelative(`./${sub}`, path.join(dir, 'package.json'));
        } else {
          const main = readJson(path.join(dir, 'package.json')).main || 'index.js';
          f = path.resolve(dir, main);
          if (!fs.existsSync(f)) {
            const idx = path.join(dir, 'index.js');
            f = fs.existsSync(idx) ? idx : null;
          }
        }
        if (f) stack.push(f);
      }
    }
  }
  return pkgs;
}

/** Does the installed package ship an Android native module? */
function shipsAndroidNative(pkgDir) {
  const dir = pkgDir;
  if (!dir || !fs.existsSync(dir)) return false;
  const hasGradle = fs.existsSync(path.join(dir, 'android', 'build.gradle'));
  let hasExpoModule = false;
  const cfg = path.join(dir, 'expo-module.config.json');
  if (fs.existsSync(cfg)) {
    try {
      const c = readJson(cfg);
      hasExpoModule = !c.platforms || c.platforms.includes('android');
    } catch {
      hasExpoModule = true;
    }
  }
  return hasGradle || hasExpoModule;
}

/** The exact source of truth the Gradle build uses. */
function autolinkedPackageNames() {
  let raw;
  if (AUTOLINK_JSON) {
    raw = fs.readFileSync(AUTOLINK_JSON, 'utf8');
  } else {
    // This is expoAutolinking.rnConfigCommand — the exact JSON
    // settings.gradle passes to autolinkLibrariesFromCommand().
    raw = execFileSync(
      'npx',
      ['--no-install', 'expo-modules-autolinking', 'react-native-config', '-p', 'android', '--json'],
      { cwd: APP_DIR, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
    );
  }
  const data = JSON.parse(raw);
  // Real shape: { root, reactNativePath, dependencies: {<packageName>: <config|null>}, project }.
  // `dependencies` is keyed by package name and already covers BOTH expo
  // modules and react-native.config.js (RN CLI) modules for the platform.
  // (Do NOT use the `resolve` subcommand here: it only lists
  // expo-module.config.json packages and misses RN-CLI modules like
  // react-native-screens.)
  const deps = data && typeof data === 'object' ? data.dependencies : null;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new Error('unrecognized react-native-config JSON shape (no dependencies object)');
  }
  const names = new Set(Object.keys(deps));
  if (names.size === 0) {
    // Fail closed and loudly: an empty set would make every native package
    // look missing. Never evaluate against an empty set.
    throw new Error('react-native-config listed zero dependencies — refusing to evaluate against an empty set');
  }
  return names;
}

function main() {
  const entry = path.join(APP_DIR, 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`FAIL: app entry not found: ${entry}`);
    process.exit(1);
  }
  const reachable = reachablePackages(entry);
  const nativePkgs = [...reachable.entries()].filter(([, dir]) => shipsAndroidNative(dir)).map(([p]) => p).sort();
  console.log(`Reachable packages from entry: ${reachable.size}; shipping Android native code: ${nativePkgs.length}`);
  let resolved;
  try {
    resolved = autolinkedPackageNames();
  } catch (e) {
    console.error(`FAIL: could not obtain autolink resolve output: ${e.message}`);
    process.exit(1);
  }
  console.log(`Autolinked (android) packages: ${resolved.size}`);
  const missing = nativePkgs.filter((p) => !resolved.has(p));
  if (missing.length) {
    console.error('FAIL: startup-reachable native packages MISSING from autolinking:');
    for (const p of missing) console.error(`  - ${p}`);
    console.error(
      'These would throw `Cannot find native module` at startup. ' +
        'Declare them as direct dependencies of apps/mobile (correct SDK line) so autolinking picks them up.'
    );
    process.exit(1);
  }
  console.log('OK: every startup-reachable Android native package is autolinked.');
}

main();
