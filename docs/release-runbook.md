# Airplane release runbook

How releases work. Building and publishing is fully automated; this document
is the human checklist around it.

## Auto-release (default)

Every push to `main` triggers `.github/workflows/auto-release.yml`, which:

1. Computes the next version from the latest `v*` tag (starts at `0.0.1`,
   then `0.0.2`, ... — patch auto-increments).
2. Bumps `apps/mobile/app.json` `expo.version`, commits with `[skip ci]`,
   pushes the commit and the new tag.
3. Builds the `preview` profile APK on EAS and attaches it to a new
   GitHub Release with generated notes.

You do nothing. Merge a PR and the release appears.

## Manual production release (AAB for Play Store)

`.github/workflows/release.yml` is manual-only: Actions tab → Release →
Run workflow → enter a tag like `v0.3.0`. It re-runs CI gates, builds the
`preview` APK and the `production` AAB on EAS, and publishes the Release
with both artifacts plus SHA256SUMS.

## Prerequisites (one-time, repo owner)

1. **`EXPO_TOKEN` repo secret** - required by both `build-android.yml` and
   `release.yml`. Generate at expo.dev → Account Settings → Access Tokens,
   then add it at:
   `https://github.com/enginoor/airplane/settings/secrets/actions`
   (name it exactly `EXPO_TOKEN`). The workflows fail fast with this same
   pointer if the secret is missing.
2. **EAS project linking** - run `eas init` once from a local machine and
   commit the resulting `projectId` into the Expo app config. Without it,
   `eas build` fails. (`eas.json` is already committed; `build-android.yml`
   carries the full note.)
3. **Production signing credentials** - the first `production` (AAB) build
   needs an Android keystore. EAS can generate one for you: run
   `eas build --platform android --profile production` once interactively
   and accept EAS-managed credentials. CI then reuses the stored credentials.

## Cutting a release (manual path - normally not needed)

Auto-release handles versioning on every `main` push. The manual path below
is only for cutting a production release with a specific version out of band.

```bash
# 1. Bump the version in the ROOT package.json (semver). The tag MUST equal
#    this value; release.yml fails loudly if they differ.
#    "version": "0.1.0"  →  "version": "0.2.0"
git add package.json
git commit -m "chore: release v0.2.0"
git push origin main

# 2. Run the manual Release workflow from the Actions tab and enter the
#    tag (e.g. v0.2.0) when prompted. It creates the tag, builds, and
#    publishes the Release.
```

Fixing a version mismatch: if release.yml fails on the tag check, delete the
bad tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), bump the
version properly, commit, and re-tag.

## What release.yml does (in order)

1. **CI gates** - `npm run lint`, `npm run typecheck`, `npm test`. Red gates
   fail the release before any build starts.
2. **Version check** - the tag (minus leading `v`) must equal root
   `package.json` `version`.
3. **EAS Android builds** - `preview` profile (APK, sideloadable) and
   `production` profile (AAB), built in the cloud with `--non-interactive`.
   Requires the `EXPO_TOKEN` secret.
4. **Artifacts** - both files are downloaded from EAS, renamed
   `airplane-vX.Y.Z-preview.apk` / `airplane-vX.Y.Z-production.aab`, and a
   `SHA256SUMS` file is generated.
5. **GitHub Release** - created at
   `https://github.com/enginoor/airplane/releases/tag/vX.Y.Z` with the APK,
   AAB and `SHA256SUMS` attached, and notes generated from
   `git log <previous-tag>..HEAD`.

## Where to find the artifacts

- The published **GitHub Release page** (link above) - this is what users
  download. Preview APK is the sideloadable one for testers; the AAB is for
  the production track.
- If a release run fails mid-way, the raw files are also on the failed run's
  **Actions → Release → EAS Android builds → Artifacts** (retained 90 days).

## Rollback policy

- **Fast-forward hotfix only.** Never rewrite history on main. Rollbacks are
  a new release with the fix (or revert) on top of main.
- **Android forbids downgrades.** An installed APK/AAB records its
  `versionCode`; installing a build with a *lower* versionCode fails on
  device. So a bad release is recovered by bumping the version again and
  shipping the next release - users can always upgrade forward. There is no
  supported "uninstall-and-reinstall-older" flow we recommend to users.
- Deleting a tag does **not** recall artifacts that were already published
  or sideloaded. If a release ships something dangerous, say so loudly in a
  new release and, for a store track, pause that track in the Play Console.

## Checklist before pushing a tag

- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass locally
- [ ] Root `package.json` version bumped, change committed
- [ ] Tag `vX.Y.Z` matches the bumped version exactly
- [ ] `EXPO_TOKEN` secret is set (first release)
- [ ] EAS production signing credentials exist (first production build)
