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

## V2 — "After-the-fact" refinement (PostToolUse)

**Idea:** once Claude's tools reveal what's *actually* happening, inject a
correction when the observed work contradicts or sharpens the ambient cadence.

- Example: ambient said `ship`, but tool output shows 3 `git reset --hard` +
  an unresolved merge conflict → inject "this is debug now: lead with hypotheses."
- A merge conflict / failing test surfacing in a tool result is a *far* stronger
  debug signal than music ever was.

**Hard constraint — must be conditional.** A `PostToolUse` hook fires on *every*
tool call; injecting every time would spam context. Discipline: **speak only when
the observed work changes the cadence read.** Silent otherwise. Needs a cheap
"has the situation materially shifted?" gate, probably comparing observed work
state against the last-injected mode.

**Open questions:**
- What's the dedup/throttle so we inject at most once per mode-change, not per tool?
- How to read tool results without parsing every tool's bespoke output shape?

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

## Esoteric / opt-in signal providers (V2+)

User idea: let people opt into playful, non-work signal sources that feed the
dials (or just color the vibe) — **only if the user indicates them as an input.**

- **Horoscope provider** — user sets their sign; fetch a daily horoscope, let its
  tone nudge dials (or just surface as flavor). Opt-in, off by default.
- **Moon phase provider** — current lunar phase as ambient context. Computable
  offline, no API.
- Slot in as ordinary `Signal` providers behind an opt-in flag in
  `~/.cadence/config.json` (e.g. `"providers": { "horoscope": "leo" }`). No
  rework needed — the provider/signal architecture already supports it.
- Open Q: do esoteric signals move dials, or only render as `vibe`/flavor so they
  never override real work signals? (Lean: flavor-only unless the user maps them.)

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
  deprecated 2024-11-27 for new apps; dev-mode Premium-gated 2026-02).
- **Now-playing via AppleScript** (Spotify/Music) — survives the macOS 15.4
  MediaRemote lockdown that killed system-wide taps like `nowplaying-cli`.
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
