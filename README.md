# cadence

> Agents that read the room.
> Claude Code has one input channel: text. Cadence is the second.

Cadence is an ambient context layer for agents. The current alpha surface is a
Claude Code hook: it injects your current **embodied state** — what you're
listening to, what you told it, how you want it to respond — into every prompt,
then asks Claude to *read your prompt through that lens*. The agent stops being
deaf to the room.

**macOS-only (alpha).** Most signals read the Mac around you; other platforms
degrade to self-report + dials + time/git.

A [Cullum&Co](https://cullum.co) project · [cadence.cullum.co](https://cadence.cullum.co)

## What it does

Before Claude sees your prompt, Cadence injects a `<user_state>` block:

```
<user_state>
  signals:
    music: "You Fail Me" — Converge (Spotify)
    vibe: aggressive, energetic
    self_report: "two beers, shipping"
  cadence:  # inferred from signals, advisory
    { pace=fast tone=warm posture=decisive proactivity=act-freely }
  reframe: read my prompt as someone in this cadence meant it: keep it fast and
    tight — answer first, trim the preamble; make the call rather than offering a
    menu of options; act without stopping to check in; keep the tone warm and
    casual. If my words clearly mean otherwise, follow my words.
</user_state>
```

It doesn't constrain the agent or rewrite your prompt — it gives the model the
context your words are missing, and a lens for reading them. The lens always
defers to what you actually typed.

## Same prompt, different room

> "how should I structure the retry logic?"

**Without Cadence** — every prompt reads the same. You get the survey: four
options, a trade-off table, and a closing "Would you like me to implement one
of these?"

**With Cadence, shipping cadence** — hardcore at 3 commits/hr, state set to
`"ship mode"` → `{ pace=fast posture=decisive proactivity=act-freely }`. You
get the call, made: exponential backoff with jitter, three attempts, here's
the diff, tests pass.

**With Cadence, thinking cadence** — ambient music, state set to
`"thinking through tradeoffs"` → `{ pace=deliberate posture=exploratory }`.
You get the options laid out patiently, trade-offs actually explored, no
pressure to pick one yet.

Same words. The room around them changed, and the agent finally saw it.

## How it works

**Signals → dials → a reframe lens.**

1. **Signals** — what Cadence can sense right now:
   - **ambient** — time of day, day of week, weather (opt-in), battery, machine
     uptime/load, dark mode, displays, wifi, Focus/DND. Mostly zero-setup;
     time/day work everywhere, the Mac-context probes are macOS. The one signal
     that's always there: `context: friday afternoon, rainy, focus on`.
     (Focus detection reads the DND database directly, so it needs your
     terminal to have Full Disk Access — `cadence signals` tells you if it
     doesn't.)
   - **git** — commits this hour, dirty files, mid-merge/rebase, read from the
     project you're in: `git: 6 dirty, mid-conflict`. Cross-platform.
   - **activity** — prompt length and minutes since your last prompt, read from
     the hook payload: `activity: { min_since_prompt=45 prompt_len=123 }`.
   - **music** — what's playing (via macOS now-playing, any player), turned into
     a clean *vibe* (mood words) via [MusicBrainz](https://musicbrainz.org). No
     Spotify login, no API key, no Premium on macOS. Off the Mac, you can link
     Spotify as a cross-platform source (`cadence spotify`, opt-in). Music moves
     three dials — energy → pace + posture, organic texture → warm tone.
   - **self-report** — what you tell it: `cadence state "two beers, shipping"`.
   - **intent** — read from the prompt you just typed: "let's ship this" →
     decisive/act-freely, "help me debug" → verify-first. Cross-platform, no
     setup; this is what makes the same prompt read differently per room.

   Time/day, self-report, git, and prompt intent move the dials (git reads
   *what you're doing*: 3+ commits/hr → fast pace, mid-conflict → verify-first);
   the rest render as context the agent reads (flavor). Self-report outranks
   prompt intent outranks git — your deliberate "I'm shipping" beats a stray
   "ship" in a prompt, which beats a mid-conflict read.
2. **Dials** — four independent knobs, each `low | medium | high`, inferred from
   the signals (or pinned by you):
   - **pace** — deliberate ↔ fast
   - **tone** — warm ↔ crisp
   - **posture** — exploratory ↔ decisive
   - **proactivity** — ask-first ↔ act-freely
3. **Reframe** — a sentence composed from the dials telling the agent how to
   *read* your prompt. Generated fresh each time; always ends "if my words
   clearly mean otherwise, follow my words."

The dials move mostly independently — high-energy-but-mellow music reads as
"fast pace, warm tone," something a single ship/think/debug label could never
express. Music is the deliberate exception: it moves pace, posture, and tone
together (you move *with* the music) but never proactivity — whether to act
without checking in stays your call, not the soundtrack's.

## Requirements

- **macOS.** Cadence is mac-only for the alpha: music (AppleScript
  now-playing), battery, dark mode, displays, wifi, and Focus/DND all read the
  Mac around you. On other platforms it still runs — self-report, dials,
  time/day, and git work anywhere, the rest degrade silently — but the product
  is built for the Mac.
- **Node 20+**
- Claude Code for the alpha adapter

## Install

In Claude Code:

```text
/plugin marketplace add cullumco/cadence
/plugin install cadence@cadence
/reload-plugins
/cadence:try
```

Then set a self-report so you can feel the difference:

```text
/cadence:state shipping, locked in
```

Alpha testers running from source — while `@cullumco/cadence` is pending npm
publish — see [`ALPHA.md`](ALPHA.md).

The prompt hook has a ~1.5s budget and exits silently when it has nothing to
say, so it never blocks or slows a prompt. The Stop hook is conservative: it
only intervenes when you're explicitly in a shipping / act-freely cadence and
Claude tries to end with a soft handoff like "want me to do that next?"

### Music vibe (optional, macOS only)

Nothing to set up. If Spotify.app or Music.app is playing, Cadence reads the
track, looks the artist's vibe up on MusicBrainz once, and caches it forever at
`~/.cadence/vibe-cache.json`. If nothing's playing, the music signal is simply
absent.

## Daily use

```bash
cadence state "two beers, shipping"   # set self-reported state (expires in 2h)
cadence state                         # print current self-report
cadence clear                         # clear it
cadence test                          # preview exactly what the hook would inject
cadence signals                       # every signal — live value, or why it's absent
```

`cadence signals` is the legibility view: it never goes silent. Every signal
Cadence knows how to read is listed with its live value, or the exact reason
it's absent — opt-in not taken, below a render threshold, missing permission
(Focus needs Full Disk Access), or platform-gated.

From inside Claude Code, the plugin skill gives the same self-report path:

```text
/cadence:state two beers, shipping
/cadence:try
```

### Driving the dials by hand

The dials are inferred, but you can pin any of them — your pin wins, the rest
keep inferring:

```bash
cadence dials                  # show the mixing board and what's pinned
cadence set pace fast          # pin a dial (accepts words OR low|medium|high)
cadence set tone warm
cadence unset pace             # back to inferred
cadence unset all
```

Pinned dials show with a `*` in the block so Claude knows they're your explicit
choice, not a guess. You can also pin per-session with env vars:
`CADENCE_PACE=fast`, `CADENCE_TONE=warm`, etc.

## The file that matters: `src/cadence.ts`

`deriveCadence()` maps your signals to the four dials, and `buildReframe()`
composes the lens. That's where your taste lives — which signal moves which dial,
and how the lens reads. A working baseline ships so it runs end-to-end
immediately; the mapping is opinionated and meant to be yours.

## Adapter posture

Claude Code is the alpha surface, not the whole product. The agnostic product
shape is:

```
signals -> cadence dials -> context envelope -> adapter-specific delivery
```

Today the adapter-specific delivery is Claude Code's `UserPromptSubmit` and
`Stop` hooks. The core signal types, cadence derivation, reframe lens, and
rendering are kept separate so future adapters can deliver the same cadence
state through other agent surfaces.

## Alpha release checklist

Before publishing:

```bash
npm run verify:alpha
npm publish --dry-run
npm run release:alpha
```

The package is scoped and configured for public npm publish via
`publishConfig.access = "public"`. The repo already ships
`.claude-plugin/marketplace.json`, so once `@cullumco/cadence` lands on npm,
the canonical install at the top of this README starts working end-to-end.

A GitHub Actions workflow exists at `.github/workflows/alpha.yml` but is
currently disabled — re-enable with `gh workflow enable Alpha` when you want
the gate to run on every push to `main`.

## What's next

See [`BACKLOG.md`](BACKLOG.md). Highlights:

- **Git nudges** — *shipped:* they move the dials from *what you said* to *what
  you're actually doing* (`3+ commits/hr → fast pace`, `mid-conflict →
  verify-first`), applied below self-report so your explicit word still wins.
- **Prompt intent** — *shipped:* ship/think/debug read straight from the prompt
  you just typed, so the "same prompt, different room" behavior fires without a
  separate `cadence state` step.
- **Opt-in signals** — anything privacy-adjacent stays off until you turn it on
  (`cadence enable <signal>`):
  - **typing tempo** — *shipped (opt-in):* prompt rhythm beyond length —
    rapid-fire short prompts read fast, one long considered prompt reads
    deliberate.
  - **calendar density** — a meeting in 20 minutes should read as `pace=fast,
    posture=decisive`; a clear afternoon as room to explore.
  - **focused app** — what's frontmost next to the terminal (docs? a profiler?
    Slack?).
  - **deeper Focus** — manual + scheduled Focus detection ship now; geofenced/
    iPhone-synced Focus leaves no local trace and stays undetectable.
- **After-the-fact injection** — the first cut ships: a `PostToolUse` hook
  watches git-ish commands and speaks exactly once when the repo enters or
  leaves a merge/rebase conflict ("this is debug now" / "conflict resolved").
  Next material events: failing-test transitions, reset/force-push thrash.
- **Opt-in flavor providers** — horoscope, moon phase, for those who want them.

## Caveats

- **macOS-only.** The alpha targets the Mac: music, battery, dark mode,
  displays, wifi, and Focus are all macOS probes. Other platforms get
  self-report + dials + time/git; everything else degrades silently.
- **Spotify's audio-features API is not used** — Spotify deprecated it for new
  apps (2024) and gated dev-mode behind Premium (2026), so vibe comes from
  MusicBrainz, not Spotify. On macOS, Cadence reads what's playing at the OS
  level (no Spotify account at all). The only Spotify API call is the still-live
  `currently-playing` endpoint, and only if you opt in via `cadence spotify` to
  get music off the Mac — identity only, never audio-features.

## License

MIT
