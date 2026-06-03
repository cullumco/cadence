# Cadence Alpha

Cadence is in Claude Code alpha. The product goal is simple: make the agent feel
less deaf to the room around the prompt.

## Try It Locally

```bash
git clone https://github.com/cullumco/cadence ~/cadence
cd ~/cadence
npm install
npm run verify:alpha
claude --plugin-dir ~/cadence
```

Inside Claude Code:

```text
/cadence:try
/cadence:state shipping, locked in
```

Then ask for something that would normally trigger a soft handoff, such as:

```text
clean up the obvious rough edges here
```

Cadence should add a `<user_state>` block before the prompt and, when you are in
a shipping cadence, the Stop hook should discourage permission-seeking endings.

## Published Install

After `@cullumco/cadence` is published to npm and this repo is pushed with
`.claude-plugin/marketplace.json`:

```text
/plugin marketplace add cullumco/cadence
/plugin install cadence@cadence
/reload-plugins
/cadence:try
```

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

Once npm is authenticated with an account that can publish `@cullumco/cadence`:

```bash
npm run release:alpha
```

That command runs the full alpha gate, confirms npm auth, and publishes the
package. `npm publish` also has a `prepublishOnly` gate as a last line of
defense.

## Current External Requirements

- A GitHub repository must exist at the marketplace path users will add.
- An npm account with access to the `@cullumco` scope must publish the package.

Current checks:
- `@cullumco/cadence` is not published on npm yet.
- `cullumco/cadence`, `scullum-fortivus/cadence`, and `Fortivuscares/cadence`
  do not currently exist on GitHub from the authenticated account available in
  this workspace.
