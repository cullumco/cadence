# Releasing Cadence

There are three independent states:

| Surface | Source of truth | What changes it |
| --- | --- | --- |
| Source and website | A commit on `main`; Vercel deployment's Git SHA | Merge a reviewed PR |
| Installable plugin | `@cullumco/cadence` on npm, `latest` dist-tag | Explicit `Release` workflow with `publish=true` |
| Installed client | Its local plugin cache | The client's normal plugin update/reload |

The marketplace points to the npm package without pinning a version. A GitHub
merge, tag or website deployment alone does not ship a new plugin package.

## One-time publisher configuration

An account owner must configure these before the first publishing run. These
are account-side settings; committing this workflow does not create them.

1. In GitHub, create the `npm` environment for `cullumco/cadence`. Restrict
   deployments to `main` and require a release reviewer. Verify the environment
   exists before dispatching with `publish=true`.
2. In npm's settings for `@cullumco/cadence`, add a GitHub Actions trusted
   publisher with organization/user **cullumco**, repository **cadence**,
   workflow filename **release.yml**, and environment **npm**. Allow npm
   publishing for that publisher; a staging-only publisher cannot run this flow.
3. The publish job uses a GitHub-hosted Ubuntu runner, Node 24, npm 11.16.0 and
   `id-token: write`. npm uses OIDC for short-lived publish credentials and
   provenance. No stored npm token or `npm login` step is required. The job's
   `contents: write` token creates the tag and GitHub Release.

See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and
[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
`npm whoami` does not test OIDC publish access. Do not substitute a long-lived
token when a publisher setting is missing; correct the configuration first.

## Prepare a candidate

1. Make the change on a branch. Set a new, unpublished stable `X.Y.Z` version
   in `package.json`, both root version fields in `package-lock.json`,
   `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.
   `npm version X.Y.Z --no-git-tag-version --ignore-scripts` updates the package
   and lockfile; update both plugin manifests too. Never push a release tag by hand.
2. Add `.github/releases/vX.Y.Z.md` with the user-visible changes. The workflow
   uses this committed text as the GitHub Release body.
3. With Node 20+ and the Claude Code CLI available, run:

   ```bash
   npm ci --ignore-scripts
   npm run release:alpha -- --dry-run
   ```

   Bare `npm run release:alpha` is also a dry run. It checks version alignment,
   builds, validates both plugin formats and the marketplace, runs tests, packs
   once and installs that tarball into a temporary consumer. The installed CLI,
   paused prompt hook and MCP protocol are smoke-tested without changing an
   active Cadence installation. It makes no publish or authentication requests.
4. Open a PR and wait for `Verify` on Linux and macOS. Merge only after review.
   Record the full 40-character merge SHA. The site may deploy through Vercel
   at this point; the npm version remains unchanged.

## Verify and publish the approved commit

Use the `Release` workflow on branch **main**. Supply the exact reviewed current
main SHA, not a branch name or short SHA. A dispatch rejects a target different
from the main commit that starts the workflow, preventing a moving branch or
an old release script from bypassing the gate.

A verification-only run is the default (`publish=false`):

```bash
gh workflow run release.yml --ref main -f target=<full-reviewed-main-sha> -F publish=false
```

Once publication is approved, dispatch:

```bash
gh workflow run release.yml --ref main -f target=<full-reviewed-main-sha> -F publish=true
```

Each run reuses `Verify` on both operating systems. The Linux job uploads the
exact installed tarball plus `release.json` (package, version, commit, clean
checkout status and SHA-512 integrity). After the `npm` environment approval,
the publishing job:

1. Checks the clean checkout and artifact against the requested commit.
2. Rejects a conflicting GitHub tag, changed npm bytes or an older version that
   would move `latest` backwards.
3. Publishes that tarball with lifecycle scripts disabled, so it cannot rebuild
   different bytes after verification.
4. Waits for npm to serve the expected version, `latest` tag and integrity.
5. Creates the tag and GitHub Release at the same tested commit, then checks it.

The workflow never deploys the website. Verification runs and tag pushes never
publish npm. The release artifact is retained for seven days.

## Verify the result and recover a partial failure

Read the workflow's final output and compare npm with the `release.json`
artifact:

```bash
npm view @cullumco/cadence dist-tags --json
npm view @cullumco/cadence@X.Y.Z dist.integrity
gh release view vX.Y.Z --repo cullumco/cadence
gh api repos/cullumco/cadence/commits/vX.Y.Z --jq .sha
```

The version must be `latest`, integrity must equal the artifact receipt and the
tag must resolve to the approved commit. Independently check the production
Vercel deployment's Git SHA and `https://cadence.cullum.co/`; see `DEPLOY.md`.
Existing users still need the normal plugin update/reload to receive changes.

If npm fails, no GitHub Release is created. If npm succeeds but the registry
check or GitHub Release step fails, inspect the run, then **re-run the failed
job in that same workflow run**. This retains the original target even if main
has advanced. Within the artifact retention window it downloads the same tested
bytes, skips npm publication when those bytes are already `latest`, and finishes
the GitHub Release. A rerun of a fully completed release is a read-only no-op.

If the artifact expired, rerun all jobs in the original run to reverify that
commit. Any different integrity stops the release; do not overwrite a version,
move a conflicting tag or roll `latest` backwards. Investigate the mismatch and
prepare a new version if necessary.
