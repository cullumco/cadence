# Cadence Alpha

Cadence is in Claude Code alpha. The product goal is simple: make the agent feel
less deaf to the room around the prompt.

## Install

The canonical install is the Claude Code marketplace:

```text
/plugin marketplace add cullumco/cadence
/plugin install cadence@cadence
/reload-plugins
/cadence:try
```

`marketplace.json` currently sources the plugin from `npm:@cullum.co/cadence`.
`/plugin marketplace add` succeeds today (the repo is live), but
`/plugin install` will fail to fetch until the npm package is published — use
"Run from source" below as the alpha fallback in the meantime.

After install, set a self-report and try something that would normally trigger
a soft handoff:

```text
/cadence:state shipping, locked in
```

```text
clean up the obvious rough edges here
```

Cadence should add a `<user_state>` block before the prompt and, when you are in
a shipping cadence, the Stop hook should discourage permission-seeking endings.

## Run from source

For alpha testers who want to iterate on the code, or to bypass the npm-publish
gap on the marketplace path:

```bash
git clone https://github.com/cullumco/cadence ~/cadence
cd ~/cadence
npm install
npm run verify:alpha
claude --plugin-dir ~/cadence
```

Inside Claude Code: `/cadence:try`, then `/cadence:state shipping, locked in`.

## Release Gate

```bash
npm run verify:alpha
npm publish --dry-run
```

`verify:alpha` validates plugin manifests, runs tests, dry-packs the npm package,
checks required plugin files, installs the packed tarball into a temporary
consumer project, verifies the installed plugin layout, and smoke-tests the
installed `cadence` binary plus prompt hook.

CI runs the same gate on GitHub Actions via `.github/workflows/alpha.yml`.

## Publish Command

Once npm is authenticated with an account that can publish `@cullum.co/cadence`:

```bash
npm run release:alpha
```

That command runs the full alpha gate, confirms npm auth, and publishes the
package. `npm publish` also has a `prepublishOnly` gate as a last line of
defense.

## Current External Requirements

- An npm account with access to the `@cullum.co` scope must publish the package.

Current state:
- GitHub: https://github.com/cullumco/cadence is live (public, MIT). CI
  runs `npm run verify:alpha` on every push to `main`.
- npm: `@cullum.co/cadence` is not published yet.
