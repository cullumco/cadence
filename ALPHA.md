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

`marketplace.json` sources the published `@cullumco/cadence` package from npm.
Source on `main` can be ahead of the published version; a merge or website
deployment does not update an installation. Existing users receive a release
through their normal plugin update/reload flow.

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

For alpha testers who want to iterate on the code or try unreleased changes:

```bash
git clone https://github.com/cullumco/cadence ~/cadence
cd ~/cadence
npm ci --ignore-scripts
npm run verify:alpha
claude --plugin-dir ~/cadence
```

Inside Claude Code: `/cadence:try`, then `/cadence:state shipping, locked in`.

## Codex Alpha

Cadence also ships a Codex plugin manifest at `.codex-plugin/plugin.json`.
Unlike the Claude Code alpha, the Codex surface is currently skill-driven: it
does not auto-inject on every prompt or run the Stop hook. Ask Codex to use
Cadence and it will run `cadence test`, read the `<user_state>` block, and apply
the dials as an advisory response lens.

The package includes:

```text
.codex-plugin/plugin.json
skills/cadence/SKILL.md
skills/state/SKILL.md
skills/try/SKILL.md
```

## Release Gate

```bash
npm run release:alpha -- --dry-run
```

The local release command defaults to verification only. Its `verify:alpha`
gate checks package/lockfile/plugin versions and release notes, builds, validates
manifests, runs tests, packs once and installs the tarball into a temporary
consumer. It checks both plugin layouts and the installed CLI, paused prompt
hook and MCP protocol without changing an active Cadence installation.

CI runs this gate on Linux and macOS through `.github/workflows/verify.yml` for
pushes and PRs to `main`. The `Release` workflow calls the same gate before any
publication. Publishing requires an explicitly selected commit, `publish=true`
and the configured npm trusted publisher. See [RELEASING.md](RELEASING.md) for
the setup, approvals, publication order and failure recovery.
