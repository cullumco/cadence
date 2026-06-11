# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cadence is an ambient context layer for agents. It ships as a Claude Code plugin
that injects a `<user_state>` block (signals + four cadence dials + a reframe
lens) ahead of every prompt via `UserPromptSubmit`, a `PostToolUse` refinement
hook that speaks only on merge-conflict-state transitions, plus a conservative
`Stop` hook that blocks soft handoffs when the user is in a shipping cadence.

The product seam is intentional: the portable core (`signals → dials → reframe`)
is kept separate from the Claude-specific adapter so future surfaces can reuse it.

## Commands

```bash
npm run build         # tsc → ./dist
npm run dev           # tsc --watch
npm test              # node --test test/cadence.test.js  (see warning below)
npm run verify:alpha  # release gate: build + plugin validate + tests + dry-pack + consumer-install smoke test
npm run release:alpha # full gate + npm publish (requires @cullumco npm auth)

npm run hook          # run dist/hook.js (UserPromptSubmit) directly
npm run cli           # run dist/cli.js (the `cadence` CLI) directly

node bin/cadence test # preview the exact <user_state> block the hook would inject right now
```

**Tests run against compiled `dist/`, not `src/`.** Every file in
`test/cadence.test.js` imports from `../dist/…`. Run `npm run build` before
`npm test` or you will be testing stale code. The `verify:alpha` script already
builds first.

**Single test:** `node --test test/cadence.test.js` runs the one test file. To
target a single case, use the Node test runner's `--test-name-pattern`:
`node --test --test-name-pattern="ship-ish self-report" test/cadence.test.js`.

**Plugin validation:** `npm run plugin:validate` runs Claude Code's `claude
plugin validate --strict` on both `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`. The Claude Code CLI must be installed.

## Architecture

### The pipeline

```
signals → cadence dials → context envelope → adapter-specific delivery
```

- **Signals** (`src/providers/*.ts`) — independent collectors, each returning a
  typed `Signal` from `src/types.ts` or `null`. Providers must always resolve;
  they never throw. Failures degrade to "no signal," never break the hook.
- **Core** (`src/cadence.ts`) — `deriveCadence()` maps signals to four
  independent dials (pace, tone, posture, proactivity, each `low|medium|high`).
  `buildReframe()` composes the second-person reframe sentence. `loadOverrides()`
  + `applyOverrides()` apply user pins from `~/.cadence/config.json` and
  `CADENCE_<DIAL>` env vars (env wins over file).
- **Render** (`src/inject.ts`) — `render()` formats the final `<user_state>`
  YAML-ish block. Pinned dials are marked with `*` so the model knows they were
  user-set, not inferred.
- **Adapter** (`src/hook.ts`, `src/posttool.ts`, `src/stop.ts`) — Claude Code's
  `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks. These read stdin
  (Claude's JSON payload with `cwd`, `prompt`, etc.), run the core, and write
  the `hookSpecificOutput.additionalContext` (prompt/posttool hooks) or
  `decision: "block"` (stop hook) JSON back on stdout. The posttool hook is
  edge-triggered: it re-observes the repo after git-ish Bash calls and speaks
  only when the merge-conflict state *changes*, tracked per session in
  `~/.cadence/workstate.json`.

### Where the personality lives

`src/cadence.ts` calls itself "THE file" in its own comments — `deriveCadence()`
is where signal-to-dial mappings are tuned. That's the *opinionated* part of the
product. Changes to which signal moves which dial belong there; adding new
*kinds* of signals goes through a new provider + a new branch in
`deriveCadence()`.

A working baseline ships so the plugin runs end-to-end out of the box, but the
mapping is meant to be evolved.

### Independence of the four dials

The dials are deliberately orthogonal. A signal should usually move *one* dial,
not all four. "High-energy-but-mellow music = fast pace, warm tone" is the kind
of combination one mode word could never express; the test
`deriveCadence: dials are independent — music sets pace, leaves posture neutral`
locks this in. Avoid edits that collapse the dials back into a single mode.

### Signal hierarchy and `deriveCadence` order

Inside `deriveCadence()`, signals are applied weakest-first so stronger signals
override. Current order: environment (soft nudges) → music energy → git →
self-report → activity. Git nudges (conflict → proactivity low, commit streak →
pace high) were enabled 2026-06-05 once the rendered signal proved trustworthy;
they sit below self-report on purpose so "I'm shipping" beats a mid-conflict
read (see `BACKLOG.md`).

### Hook budget and "silent when empty"

The `UserPromptSubmit` hook has a hard 1500ms total budget
(`TOTAL_BUDGET_MS` in `src/hook.ts`); signal collection runs through
`Promise.race` against a timer. If nothing is available — no signals and no
pinned dials — the hook exits silently with no output, so it never blocks or
slows a prompt. Always preserve this property.

### Stop hook posture (conservative on purpose)

`src/stop.ts` only blocks when **all** of the following hold:
1. `stop_hook_active` is not already set
2. No background tasks are running
3. The user has explicit *shipping authority*: a ship-pattern self-report
   *or* a user-pinned `proactivity=high` / `posture=high`
4. The last assistant message looks like a soft handoff (permission question
   or passive offer at the end)

Adding new conditions should keep the same posture: conservative, only when the
user has visibly opted in via self-report or pinned dials. Inferred high
proactivity alone must *not* be enough to block.

### Distribution: TS → dist → packaged plugin

The TypeScript in `src/` compiles to `dist/`. The npm package and the
`.claude-plugin/` manifests both point at `dist/hook.js` and `dist/stop.js`.
The `hooks/hooks.json` file references `${CLAUDE_PLUGIN_ROOT}/dist/hook.js` —
do not change those paths casually; `verify:alpha` smoke-tests them by
installing the packed tarball into a temp consumer project and running the
installed hook binary.

`bin/cadence` is the published CLI shim that `import()`s `dist/cli.js`.
`tsconfig.json` uses `NodeNext` modules with `noUncheckedIndexedAccess` —
expect to handle `array[i]` as possibly `undefined`.

### Skills

`skills/try/SKILL.md` and `skills/state/SKILL.md` are the user-invocable plugin
skills (`/cadence:try`, `/cadence:state`). Both have `disable-model-invocation:
true` so they only fire on explicit user invocation, not automatic model
matching. Keep their bodies short and operational — they should not
re-explain the product.

## Conventions worth knowing

- **macOS-only signals** (music, battery, focus, displays, network SSID, dark
  mode) live behind `process.platform === "darwin"` checks. Anything new in
  that category must degrade silently on Linux/Windows.
- **No new network deps without a strong case.** Current network calls are
  MusicBrainz (one-time per artist, cached forever in `~/.cadence/vibe-cache.json`)
  and Open-Meteo (opt-in, requires explicit `cadence set-location`). Both are
  keyless and bounded by short `AbortController` timeouts.
- **Vibe table is a blocklist, not an allowlist** (`src/providers/music.ts`
  `isVibeTag`). Novel genres should pass through; we only reject known classes
  of junk (places, listener-meta tags, artist name fragments).
- **State lives in `~/.cadence/`**: `state.txt` (self-report, 4h TTL),
  `config.json` (pinned dials + weather location + esoteric-provider opt-ins
  like `"providers": { "moon": true }`), `activity.json` (last
  prompt timestamp), `vibe-cache.json` (MusicBrainz tag cache),
  `workstate.json` (per-session conflict state for the PostToolUse hook,
  pruned to 20 sessions).
