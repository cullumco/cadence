# Cadence — Backlog

Future versions and capabilities, captured during the Spotify→embodied-state pivot.
Claude Code is the alpha surface; the product is the ambient context layer
underneath it. V1 scope is deliberately small: **before-only** injection (a
`UserPromptSubmit` reframe lens). Everything below is intentionally deferred.

---

## The big idea: from one-shot prefix to a feedback loop

Today Cadence starts on Claude Code hooks, because they are the fastest alpha
surface for proving the feel. The long-term shape stays adapter-agnostic:

```
signals -> cadence dials -> context envelope -> adapter-specific delivery
```

In the first hook, Cadence injects once, *before* Claude works — so it can only
reframe how to **read** the prompt from *ambient* state (music, mood, git-at-rest).
It guesses your cadence; it can't see the actual work yet.

But `additionalContext` can also be injected by `PostToolUse`, `PostToolBatch`,
and `Stop` hooks (verified against Claude Code docs). Those fire *after* the work
reveals itself — which is a more honest signal than any proxy. The roadmap is to
grow Cadence from a prompt-prefix into a loop around the whole turn:

```
UserPromptSubmit  → set the reading lens   (predictive, ambient)   ← V1, done
PostToolUse       → refine / course-correct (observed work)         ← V2
Stop              → conservative finish-line guard                   ← V1.1, done
```

---

## V2 — "After-the-fact" refinement (PostToolUse) — first cut SHIPPED (2026-06-05)

`src/posttool.ts` ships the conservative cut. One material event: the repo
entering/leaving a merge-rebase conflict, observed after git-ish Bash calls.

Answers to the open questions, as built:
- **Dedup/throttle:** speak only on conflict-state TRANSITIONS, tracked per
  session in `~/.cadence/workstate.json` (pruned to 20 sessions). Two gates:
  `shouldCheck()` (only Bash commands mentioning git — plus a `"Bash"` matcher
  in hooks.json so the process doesn't even spawn otherwise) and
  `refineContext()` (edge-triggered, both directions, silent on no-change).
- **Tool output parsing:** sidestepped — we don't parse `tool_response` at
  all; we re-observe the repo with the existing git provider instead.

**Next material events to consider** (same transition discipline):
- failing-test transitions (needs a cheap, tool-agnostic "tests failed" read)
- `git reset --hard` streaks / force-pushes → thrash signal
- dirty-file count exploding mid-task

## V3 — Finish-line enforcement (Stop)

**V1.1 shipped:** a conservative `Stop` hook now blocks only one class of miss:
explicit shipping / act-freely cadence plus a soft handoff ending ("want me to
do that next?", "let me know if..."). It checks `stop_hook_active` to avoid
recursive blocks.

**Larger idea:** the `Stop` hook fires when Claude thinks it's done and can
decide whether to continue. This is where cadence actually *bites*.

- `ship` cadence + Claude stopping to ask a clarifying question → "user is
  shipping; don't stop to ask, make the call and finish."
- `think` cadence + Claude charging ahead → "user is weighing direction; pause
  and lay out the options before committing."

**Why high-leverage:** fewer injections than PostToolUse (one per turn-end),
at the moment that most shapes the felt experience (decisive vs. deliberate finish).

**Open questions:**
- When is overriding a Stop *too* aggressive (loops, ignoring a genuine blocker)?
- Should Stop enforcement be opt-in, given it can re-route Claude mid-task?

## V4 — Full loop (all three composed)

Lens at start → refine during → enforce at end. Most powerful, most tokens, most
complexity. Only worth it once V2/V3 each prove their gating keeps noise down.

## Adapter expansion

Keep the core reusable before adding more surfaces. Claude Code-specific pieces
should stay in hook/adapter files; providers, dial derivation, stop decisions,
and renderers should remain portable. Candidate future surfaces:
- a JSON context CLI for any agent shell
- MCP/resource-style context exposure
- Codex/Cursor-style adapters if their hooks/context APIs support it
- a thin Claude Code plugin wrapper once the hook shape settles

---

## Esoteric / opt-in signal providers — SHIPPED (flavor-only)

`src/providers/esoteric.ts` ships both, render-only (they never move a dial,
per the lean below):
- **Moon phase** — computed offline from the date, no API, gated on
  `providers.moon`.
- **Horoscope** — `providers.horoscope = "<sign>"`; daily text via a keyless
  API, opt-in and fail-silent exactly like the weather probe.

Resolved open Q: esoteric signals are **flavor-only** — they color the block,
never override real work signals. Revisit only if a user explicitly wants to
map one to a dial.

**Focused app** also shipped here (opt-in `providers.focusedApp`, macOS): the
frontmost non-terminal app as flavor on the ambient context line. Caveat baked
in — it's read at UserPromptSubmit, when your terminal/IDE is usually frontmost,
so it filters known shells/editors and speaks only when something else is in
front. Flavor for now; `focused app → posture/proactivity` stays a candidate
nudge once real output shows it's worth steering on.

**Calendar density: cut.** The audience is solo builders in a long project, not
people racing between meetings — so meeting-proximity isn't a fit. Removed from
the roadmap above.

## Known nuance: intra-tier nudge collisions

When two *ambient* nudges touch the same dial, the later one silently wins (e.g.
late-night says low-pace, unplugged says high-pace → unplugged wins by source
order). Across tiers this is intentional (self-report > ambient), but *within*
ambient the ordering is arbitrary. Fine for now; if it bites, move to a
weighted/voting model per dial instead of last-write-wins.

## Git nudges — SHIPPED (2026-06-05)

Enabled after the flavor proved trustworthy in real use:
- `conflicted` → proactivity low (verify, don't barrel — you're in the weeds)
- `commitsLastHour >= 3` → pace high (flow state)
Applied below self-report in the hierarchy, so "I'm shipping" beats a
mid-conflict read. Watch for false positives (e.g. rebase-heavy workflows
reading as flow state) before adding more git nudges.

## Prompt intent — SHIPPED

`src/providers/intent.ts` reads ship/think/debug/focus cues from the live
prompt and drives the same dials as a self-report, applied *between* git and
self-report (a deliberate `cadence state` still wins). This is what makes the
"same prompt, different room" demo true without a separate CLI step. Patterns
are deliberately phrase-based, not bare-word, so ordinary prompts ("can you
just check…", "why is this slow?") don't misfire — and the reframe still
defers to the literal words, so a miss stays cheap.

## Opt-in provider registry — SHIPPED

`src/config.ts` adds a `providers` block to `~/.cadence/config.json` — the
consent layer for "as many signals as the user is willing to give." Anything
privacy-adjacent stays off until `cadence enable <signal>`. `OPT_IN_PROVIDERS`
is the single source of truth (CLI + signals view + providers). First opt-in
signal on it: **typing tempo** — a rolling prompt-rhythm window in
`activity.ts` (`computeTempo`), where rapid-fire short prompts → pace high and
one long considered prompt → pace low. Next opt-in signals to slot in here:
focused app, calendar density, esoteric (horoscope/moon).

## Other deferred provider/feature ideas

- **`activity.ts` provider** — first cut shipped: prompt length plus minutes
  since the last prompt from the `UserPromptSubmit` payload. Future refinement:
  use prompt length itself as a nudge once real output shows the boundary.
- **wifi SSID fragility** — `ipconfig getsummary` needs Location Services
  permission on recent macOS, so SSID is often empty for downloaders. Degrades to
  absent (not a bug). If we want it reliable, prompt for the permission or drop it.
- **macOS Focus / DND** — manual AND scheduled detection ship: `getFocus()`
  reads `Assertions.json` (manual toggles) and falls back to
  `ModeConfigurations.json` schedule math (`scheduleActive()`, fixture-tested,
  handles midnight-wrapping windows). Needs terminal Full Disk Access; degrades
  to absent without it. Remaining gap: geofenced/iPhone-synced Focus writes
  neither file — undetectable from this Mac. Render-only flavor;
  `focus on → proactivity high` is a dormant candidate nudge.
- **More ambient nudges** — calendar density (next-meeting proximity), ambient
  light, active-app focus. All cheap, all backlogged.
- **`energyToMode` boundary** — the sad-slowcore think-vs-debug call in `vibe.ts`
  is still a placeholder; decide whether music should ever lean `debug` at all,
  or leave `debug` entirely to the git provider.
- **`reframe` tone reconciliation** — the reframe lenses now defer to the user's
  words; make sure no other rendered line contradicts that humility.
- **Tests** — baseline smoke coverage exists for `tagsToVibe`, `deriveCadence`,
  overrides, rendering, and the reframe lens. Keep extending around providers
  and hook input/output as the loop grows.
- **Landing page** — keep copy aligned with the OS-now-playing +
  MusicBrainz-vibe + reframe-lens reality as install/distribution changes.
- **Genre→affect table growth** — `GENRE_AFFECT` in `vibe.ts` is small/hand-
  authored; extend as artists miss, or compute means from the Kaggle 114k-track
  dataset (per deep-research finding — no published table exists).

---

## Settled decisions (context for the above)

- **Music = identity + vibe**, not numeric affect (Spotify audio-features
  deprecated 2024-11-27 for new apps; dev-mode Premium-gated 2026-02). Music
  now moves THREE dials (energy → pace + posture, acoustic → warm tone), never
  proactivity — "move with the music," see `deriveCadence`.
- **Now-playing via AppleScript** (Spotify/Music) — survives the macOS 15.4
  MediaRemote lockdown that killed system-wide taps like `nowplaying-cli`. The
  cross-platform path (opt-in `src/providers/spotify.ts`) uses only the live
  `currently-playing` endpoint — identity only, no audio-features. Linking is a
  PKCE browser flow in the *interactive CLI* (`cadence spotify connect`,
  `src/spotify-auth.ts`): a one-shot loopback server catches the redirect and
  exchanges the code for a refresh token. OAuth NEVER runs in the hook — the
  hook only reads the cached token. To ship zero-config, register a "Cadence"
  Spotify app and set `DEFAULT_SPOTIFY_CLIENT_ID` (or `CADENCE_SPOTIFY_CLIENT_ID`)
  with `http://127.0.0.1:8888/callback` as a redirect URI. Manual
  `cadence spotify <clientId> <refreshToken>` remains for the browser-less.
- **Vibe via MusicBrainz** — keyless, no auth, cached per-artist forever.
- **Mood vocabulary = Cyanite's 13** (research-verified controlled set).
- **Influence = prompt only** — a hook cannot change the model, system prompt,
  output style, or generation params; `additionalContext` is the only lever.
- **Style = interpretation lens** ("read my prompt as someone in X cadence meant
  it"), not behavioral commands (caveman) and not prompt rewriting (impossible
  automatically). Always defers to the user's literal words.
- **No single mode label** — Cadence drives FOUR independent dials (pace, tone,
  posture, proactivity), each low/medium/high, instead of collapsing to
  ship/think/debug. `mode.ts` deleted; `cadence.ts` is the brain. Deliberate move
  off the 3-way switch so signals pull dials orthogonally and nothing is lost.
- **Manual override = "user's determination, rest auto."** Any dial can be pinned
  via `~/.cadence/config.json` or env (`CADENCE_PACE=fast`); pinned dials win,
  un-pinned stay inferred. Pinned dials render with `*` so the model knows they
  carry explicit user authority. `set` accepts words ("fast") or levels ("high").
  CLI: `cadence dials | set | unset`.
