# Releasing Controller

This is the manual procedure for cutting a Controller release. There is no
release CI yet — builds and the GitHub release are produced from a developer
machine. macOS artifacts must be built on macOS (Apple Silicon); Linux
artifacts are produced from the same `electron-builder` invocation.

Replace `X.Y.Z` with the target version (e.g. `0.2.0`) throughout.

## 1. Prepare the branch

```sh
git checkout main && git pull
git checkout -b release/X.Y.Z
```

## 2. Bump the version

```sh
npm version X.Y.Z --no-git-tag-version
```

This updates `package.json` and `package-lock.json`. The `--no-git-tag-version`
flag is important: we tag manually after the release commit so the tag points
at the changelog too. The docs site (`docs/package.json`) versions
independently and is not touched here.

## 3. Update the changelog

Edit `CHANGELOG.md`:

- Rename the working `## [Unreleased]` section to `## [X.Y.Z] - YYYY-MM-DD`
  and add a fresh empty `## [Unreleased]` placeholder above it.
- Consolidate entries under a single `### Added` / `### Changed` / `### Fixed`
  (and `### Docs`, if relevant) heading each.
- Fold in any notable commits landed since the last tag that were never
  recorded in `[Unreleased]`. Find them with:

  ```sh
  git log vPREV..HEAD --no-merges --pretty='%s'
  ```

- Keep the macOS Gatekeeper note (ad-hoc-signed, not notarized → **Open
  Anyway**) and call out any breaking changes / required manual migration
  steps prominently at the top of the section.

## 4. Validate

```sh
npm test
npm run build
```

Both must pass before tagging.

## 5. Commit, tag, push

```sh
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git push -u origin release/X.Y.Z
```

Open a PR, get it reviewed, and merge to `main`. Tag the merge commit:

```sh
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

## 6. Build and sign the artifacts

```sh
npm run package:electron:dist
```

This runs `npm run build`, then `electron-builder --mac --linux`, then
`electron/resign-mac.mjs`. The resign step `codesign --force --deep --sign -`
the macOS bundle so it carries a well-formed ad-hoc signature (without it the
shipped `.zip`/`.dmg` fail to launch). Artifacts land in `release/`:

- macOS — `Controller-X.Y.Z-arm64-mac.zip`, `Controller-X.Y.Z-arm64.dmg`
- Linux — `Controller-X.Y.Z-arm64.AppImage`

> The macOS build is **ad-hoc-signed and not notarized**. There is no
> Developer ID signing or auto-update channel yet. Intel macOS and x86_64
> Linux builds are not produced by default — note that in the release if
> they're missing.

## 7. Publish the GitHub release

```sh
gh release create vX.Y.Z \
  --title "Controller X.Y.Z" \
  --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md) \
  release/Controller-X.Y.Z-arm64-mac.zip \
  release/Controller-X.Y.Z-arm64.dmg \
  release/Controller-X.Y.Z-arm64.AppImage
```

Review the rendered notes and the attached binaries on the release page.
Always include the macOS Gatekeeper "Open Anyway" instructions in the
release body, since the build is un-notarized.

## Post-release

- Verify a fresh download launches on macOS (first launch needs the
  **System Settings → Privacy & Security → Open Anyway** approval).
- Open follow-up issues for anything deferred (signing/notarization,
  auto-update, additional architectures).
</content>
</invoke>
