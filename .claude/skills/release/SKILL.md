---
name: release
description: Prepare and publish a Cadence release through the verified GitHub Actions workflow. Use when the user says "release", "publish", "cut a version", or "ship it to npm". Explicitly invoking this skill authorizes publication unless the user limits the task to preparation or a dry run.
---

# Release Cadence

Follow `RELEASING.md`. Respect the user's requested scope: preparing a release,
fixing the pipeline or running a dry run does not authorize publication. An
explicit `/release` invocation authorizes the documented release flow unless
the user limits it; do not ask for the same authorization again. Account-side
publisher and environment settings require the account owner's authorization.

1. Check the current npm version and GitHub Release. Decide an unpublished
   version; do not assume `main` has already shipped.
2. On a branch, synchronize `package.json`, both root versions in
   `package-lock.json`, `.claude-plugin/plugin.json` and
   `.codex-plugin/plugin.json`. The marketplace's npm source stays unpinned.
3. Write `.github/releases/vX.Y.Z.md` before committing. Run
   `npm run release:alpha -- --dry-run`: build, version/manifest checks, tests,
   pack and temporary consumer smoke test. The local command never publishes.
4. Commit the candidate, open a PR and wait for Linux/macOS `Verify` checks.
   Merge only within the user's authorized scope. Record the full main merge SHA.
5. Confirm the `npm` GitHub environment and npm trusted publisher are configured
   as documented. Do not log in, create credentials or alter security settings
   as a workaround for missing configuration.
6. If publication is authorized, dispatch `Release` on **main** with `target`
   equal to that reviewed current main SHA and `publish=true`. Otherwise use
   `publish=false` or return the prepared PR. Never publish locally or push a tag.

   ```bash
   gh workflow run release.yml --ref main -f target=<full-reviewed-main-sha> -F publish=true
   ```

7. Follow the run through verification and its environment approval. It
   publishes the tested artifact, confirms npm version/integrity, then creates
   the matching GitHub tag and release. Compare the artifact receipt, npm
   `latest` and the tag's commit before reporting success.
8. If a step fails, use the recovery section in `RELEASING.md`. Re-run the
   original failed job to retain its target/artifact; never overwrite a package
   version, move a conflicting tag or manually mark an unverified release done.

Vercel deploys the website from `main` independently. Its success is not evidence
of npm publication, and npm publication does not update users' plugin caches.
