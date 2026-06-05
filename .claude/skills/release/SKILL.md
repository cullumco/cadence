---
name: release
description: Cut and publish a Cadence alpha release to npm. Use when the user says "release", "publish", "cut a version", or "ship it to npm". Invoking this skill IS the explicit authorization to publish.
---

# Release a Cadence alpha

The user invoking `/release` is the explicit go-ahead for the npm publish —
do not re-ask.

## Steps

1. **Decide the bump.** Patch unless the user named a version. Check what's
   live: `npm view @cullumco/cadence version`.
2. **Bump BOTH manifests** — they must match or the verify gate fails
   (the consumer smoke test checks the installed plugin version against
   package.json):
   - `package.json` → `version`
   - `.claude-plugin/plugin.json` → `version`
3. **Publish via the gate** (never `npm publish` directly):
   ```bash
   npm run release:alpha
   ```
   This runs `verify:alpha` (build, plugin validate, tests, dry-pack,
   consumer-install smoke test) and then publishes. Requires @cullumco npm
   auth (`npm whoami`).
4. **Commit + push the bump** on main:
   ```
   Bump version to X.Y.Z
   ```
5. **Confirm**: `npm view @cullumco/cadence version` returns the new version.

## Gotchas learned in real releases

- Tests run against `dist/`, not `src/` — the gate builds first, but if you
  ran tests by hand before bumping, rebuild.
- `marketplace.json` has no per-plugin version field — nothing to bump there.
- The npm downloads API takes ~24h to index a first publish; "not found"
  from api.npmjs.org right after publishing is normal.
- `npm view` itself can serve the OLD version for ~15s after publish
  (registry read-replica lag) — wait and re-check before declaring failure.
- Plugin installers get the new version through npm (`source: npm`), so
  publishing is what actually ships hook changes to users — pushing main
  alone does not.
