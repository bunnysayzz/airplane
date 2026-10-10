# Airplane release runbook

How to cut a release. The actual building and publishing is automated by
`.github/workflows/release.yml`; this document is the human checklist that
drives it.

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

## Cutting a release

```bash
# 1. Bump the version in the ROOT package.json (semver). The tag MUST equal
#    this value; release.yml fails loudly if they differ.
#    "version": "0.1.0"  →  "version": "0.2.0"
git add package.json
git commit -m "chore: release v0.2.0"

# 2. Tag the commit. Tags must look like vX.Y.Z (release.yml only triggers
#    on that pattern).
git tag v0.2.0

# 3. Push the tag. This triggers .github/workflows/release.yml.
git push --tags
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
