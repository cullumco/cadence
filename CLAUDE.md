# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cadence is an ambient context layer for agents. It ships as a Claude Code plugin
that injects a `<user_state>` block (signals + four cadence dials + a reframe
lens) ahead of every prompt via `UserPromptSubmit`, plus a conservative `Stop`
hook that blocks soft handoffs when the user is in a shipping cadence.

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
plugin validate` on `.claude-plugin/plugin.json` (non-strict on purpose: the
repo root doubles as the plugin root, so the dev-only CLAUDE.md — excluded
from the tarball — trips a strict-mode warning) and `--strict` on
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
- **Adapter** (`src/hook.ts`, `src/stop.ts`) — Claude Code's
  `UserPromptSubmit` and `Stop` hooks. These read stdin (Claude's JSON payload
  with `cwd`, `prompt`, etc.), run the core, and write the
  `hookSpecificOutput.additionalContext` (prompt hook) or `decision: "block"`
  (stop hook) JSON back on stdout.

### Where the personality lives

`src/cadence.ts` calls itself "THE file" in its own comments — `deriveCadence()`
is where signal-to-dial mappings are tuned. That's the *opinionated* part of the
product. Changes to which signal moves which dial belong there; adding new
*kinds* of signals goes through a new provider + a new branch in
`deriveCadence()`.

A working baseline ships so the plugin runs end-to-end out of the box, but the
mapping is meant to be evolved.

`deriveCadenceTraced()` is the attribution source for the learning loop: every
nudge inside it carries a stable rule id (`env.late`, `report.ship`, …) that
the opt-in tune log records, so `cadence tune` can attribute next-prompt
pushback to the exact rule. Keep rule ids stable across retunes where possible
— renames orphan historical entries (the report degrades to grouping by source).

### Independence of the four dials

The dials are deliberately orthogonal. The invariant is **no single signal
moves all four** — so nothing collapses back into one ship/think/debug mode.
"High-energy-but-mellow music = fast pace, warm tone" is the kind of
combination one mode word could never express.

Music is the deliberate three-dial exception ("move with the music"): energy
drives **pace** and **posture**, acoustic texture warms **tone** — but music
never touches **proactivity** (whether to act without checking in is the
user's call via self-report/intent/git, never the soundtrack's). The test
`deriveCadence: music moves pace/posture/tone but never proactivity` locks
that boundary in. Avoid edits that let any one signal drive the whole board.

### Signal hierarchy and `deriveCadence` order

Inside `deriveCadence()`, signals are applied weakest-first so stronger signals
override. Current order: ambient (soft nudges) → music energy → git → prompt
intent → self-report → activity (typing tempo + return-from-break). Each tier
can override the one above it on a shared dial.

Two notes on authority:
- **Git is live** (since 2026-06-05), not dormant: `3+ commits/hr → pace high`,
  `conflicted → proactivity low`. It sits *below* self-report so an explicit
  `cadence report "shipping"` still beats a mid-conflict read.
- **Prompt intent** (`src/providers/intent.ts`) reads ship/think/debug cues
  from the live prompt and sits between git and self-report — strong enough to
  drive the "same prompt, different room" behavior without a separate CLI step,
  but a deliberate self-report still outranks it.
- **Ambient focus is live** (since 2026-07-03, formerly the last dormant
  nudge): a MANUALLY flipped Focus (`focusManual`, an assertion — never a
  scheduled window) → `proactivity high`, ambient tier, so git/intent/
  self-report all override. It carries a guard: if the other environment
  sub-rules already moved three dials, `env.focus` stays quiet — the
  no-single-signal-moves-all-four invariant holds for the environment bundle
  too. Inferred proactivity still never grants Stop-hook authority.

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

`skills/*/SKILL.md` are the user-invocable plugin skills: `/cadence:setup`
(conversational onboarding — Claude interviews the user and drives the CLI),
`/cadence:state`, `/cadence:try`, `/cadence:tune`, `/cadence:pause`,
`/cadence:resume`, plus `skills/cadence` (the manual readout path for
harnesses without prompt hooks — the Codex plugin's entry point; the same
directory is shared by both plugin manifests, so every skill must stay
surface-neutral). All have `disable-model-invocation: true` so they only fire
on explicit user invocation, not automatic model matching — this is an
invariant; do not flip it for any surface. No `name:` frontmatter — the
directory name is the invocation name. Keep their bodies short and
operational — they should not re-explain the product. The rule that binds
them: **skills orchestrate, the CLI is the source of truth** — a skill runs
`cadence …` commands via Bash and never edits `~/.cadence/` files directly.

### Pause (the kill switch)

`cadence pause` sets `"paused": true` in `~/.cadence/config.json`. Every hook
checks `isPaused()` (src/config.ts) FIRST and exits silently — no probes, no
subprocesses, nothing injected. The one exception: the SessionStart greeting
says "paused" once per session (user-facing legibility — "off" must never read
as "broken"). State survives a pause untouched; `cadence resume` deletes the
flag. Any new hook must add the same first-line check.

## Conventions worth knowing

- **macOS-only signals** (music, battery, focus, displays, network SSID, dark
  mode) live behind `process.platform === "darwin"` checks. Anything new in
  that category must degrade silently on Linux/Windows.
- **No new network deps without a strong case.** Current network calls are
  MusicBrainz (one-time per artist, cached forever in `~/.cadence/vibe-cache.json`),
  Open-Meteo (opt-in, requires explicit `cadence set-location`; cached 30 min
  in `~/.cadence/weather-cache.json` so prompt+stop don't double-fetch), the opt-in
  Spotify `currently-playing` endpoint, and the opt-in daily horoscope. All are
  keyless or user-credentialed, opt-in, and bounded by short `AbortController`
  timeouts. MusicBrainz is the ONE deliberate exception to opt-in (decided
  2026-06-11): the zero-config music demo is the product's hook, and the call
  sends only an artist name — keyless, cached forever. Don't "fix" this.
- **OAuth lives in the interactive CLI, never the hook.** The hook has no
  browser and a 1.5s budget. `cadence spotify connect` (`src/spotify-auth.ts`)
  runs a PKCE flow with a one-shot loopback server and stores a refresh token;
  the hook-side provider (`src/providers/spotify.ts`) only ever reads/refreshes
  the cached token, fail-silent. Any future "connect a service" follows this
  shape — auth in the CLI, token-read in the hook.
- **Opt-in provider registry** (`src/config.ts`, `OPT_IN_PROVIDERS`): anything
  privacy-adjacent (typing tempo, focused app, wifi SSID, esoteric, Spotify)
  stays off until `cadence enable <signal>` / `cadence spotify connect`. New
  signals of that kind register here and gate on `providerEnabled()`.
- **Vibe table is a blocklist, not an allowlist** (`src/providers/music.ts`
  `isVibeTag`). Novel genres should pass through; we only reject known classes
  of junk (places, listener-meta tags, artist name fragments).
- **State lives in `~/.cadence/`**: `state.txt` (self-report, 2h TTL),
  `config.json` (pinned dials + weather location + `providers` opt-in registry),
  `activity.json` (last prompt timestamp + tempo window), `vibe-cache.json`
  (MusicBrainz tag cache), `weather-cache.json` (30-min weather word),
  `spotify-token.json` (cached access token), `workstate.json` (PostToolUse
  conflict/thrash/tests state), `tune.json` (opt-in learning log — derived
  prompt features only, never text; pruned to 500 entries on every write).
