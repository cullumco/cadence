# cadence

> Agents that read the room.
> Claude Code has one input channel: text. Cadence is the second.

Cadence is an ambient context layer for agents. The current alpha surface is a
Claude Code hook: it injects your current **embodied state** — what you're
listening to, what you told it, how you want it to respond — into every prompt,
then asks Claude to *read your prompt through that lens*. The agent stops being
deaf to the room.

**Built for the Mac (alpha).** The richest ambient signals read the Mac around
you. Other platforms still get the dial-movers — prompt intent, self-report,
git, time/day, typing tempo — and can link Spotify for music
(`cadence spotify connect`).

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

**With Cadence, shipping cadence** — hardcore at 3 commits/hr, a "let's ship
it" earlier in your prompt (or `cadence state "ship mode"`) →
`{ pace=fast posture=decisive proactivity=act-freely }`. You get the call,
made: exponential backoff with jitter, three attempts, here's the diff, tests
pass.

**With Cadence, thinking cadence** — ambient music, "thinking through
tradeoffs" in your own words → `{ pace=deliberate posture=exploratory }`. You
get the options laid out patiently, trade-offs actually explored, no pressure
to pick one yet.

Same words. The room around them changed, and the agent finally saw it. No
setup required for the intent read — your prompt itself is a signal; a
deliberate self-report just outranks it.

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
     Spotify login, no API key, no Premium on macOS. Off the Mac, link Spotify
     once with `cadence spotify connect` (browser OAuth, opt-in). Music moves
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

- **Built for the Mac.** The richest ambient probes — music via AppleScript
  now-playing, battery, dark mode, displays, wifi, Focus/DND, focused app —
  read the Mac around you. On other platforms Cadence still runs and still
  moves the dials: prompt intent, self-report, git, time/day, and typing tempo
  work anywhere, Spotify can be linked for music, and the Mac-only probes
  degrade silently.
- **Node 20+**
- Claude Code for the alpha adapter

## Install

In Claude Code:

```text
/plugin marketplace add cullumco/cadence
/plugin install cadence@cadence
/reload-plugins
/cadence:setup
```

`/cadence:setup` is a short conversation, not a wizard — tell Claude how you
work, pick which signals you're willing to share, and see exactly what gets
injected. Or skip it and just set a self-report:

```text
/cadence:state shipping, locked in
```

Change your mind anytime: `/cadence:pause` silences everything instantly,
`/cadence:resume` brings it back.

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

**Off macOS?** Run `cadence spotify connect <clientId>` once: register a Spotify
app (add `http://127.0.0.1:8888/callback` as a redirect URI), and Cadence does
the browser OAuth and stores a refresh token. From then on it reads your
currently-playing track cross-platform — identity only, vibe still from
MusicBrainz, no audio-features.

## Daily use

```bash
cadence state "two beers, shipping"   # set self-reported state (expires in 2h)
cadence state                         # print current self-report
cadence clear                         # clear it
cadence test                          # preview exactly what the hook would inject
cadence signals                       # every signal — live value, or why it's absent
cadence pause                         # silence all hooks (state survives untouched)
cadence resume                        # start reading the room again
```

`cadence signals` is the legibility view: it never goes silent. Every signal
Cadence knows how to read is listed with its live value, or the exact reason
it's absent — opt-in not taken, below a render threshold, missing permission
(Focus needs Full Disk Access), or platform-gated.

From inside Claude Code, the plugin skills cover the same ground without
leaving the conversation:

```text
/cadence:setup                    # guided, conversational setup — shape the
                                  # influence and pick your opt-in signals
/cadence:state two beers, shipping
/cadence:try                      # what is Cadence seeing right now?
/cadence:pause                    # instant silence — prompts go through untouched
/cadence:resume                   # back to reading the room
```

`/cadence:setup` is the recommended first run inside Claude Code: instead of a
fixed wizard, you tell Claude how you work in plain language and it drives the
CLI for you — state, dial pins, and which opt-in signals you're willing to
share.

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

`@cullumco/cadence` is live on npm; each release is the same gated flow:

```bash
npm run verify:alpha    # build + plugin validate + tests + dry-pack + install smoke test
npm run release:alpha   # the full gate, then npm publish
# then: write .github/releases/vX.Y.Z.md and dispatch the Release workflow —
# it creates the tag + GitHub Release from that file
gh workflow run Release -f tag=vX.Y.Z -f target=<bump-commit>
```

CI runs the same gate on every push/PR to `main`
(`.github/workflows/verify.yml`); `.github/workflows/release.yml` turns each
release into a tag + GitHub Release whose body is the committed notes file.

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
  - **focused app** — *shipped (opt-in, macOS):* the frontmost non-terminal app
    (a browser, Slack, a PDF) renders as flavor. Read at prompt-submit, so it
    only speaks when something other than your terminal/IDE is genuinely in
    front. Flavor for now; a dial nudge stays a candidate.
  - **esoteric flavor** — *shipped (opt-in):* `moon` phase (computed offline)
    and a daily `horoscope` for your sign. Render-only — they color the room,
    they never steer the work.
  - **deeper Focus** — manual + scheduled Focus detection ship now; geofenced/
    iPhone-synced Focus leaves no local trace and stays undetectable.
- **Calendar density** — intentionally *not* built: Cadence targets solo
  builders deep in a project, not people racing between meetings.
- **After-the-fact injection** — shipped: a `PostToolUse` hook watches git-ish
  commands and speaks once per transition — entering/leaving a merge/rebase
  conflict, and destructive-op thrash (reset --hard streaks, force-pushes).
  Next material event: failing-test transitions.

## Caveats

- **Built for the Mac.** The richest ambient probes (music-via-OS, battery,
  dark mode, displays, wifi, Focus, focused app) are macOS. Other platforms
  keep the dial-movers — intent, self-report, git, time/day, typing tempo,
  linked Spotify — and the rest degrades silently.
- **Spotify's audio-features API is not used** — Spotify deprecated it for new
  apps (2024) and gated dev-mode behind Premium (2026), so vibe comes from
  MusicBrainz, not Spotify. On macOS, Cadence reads what's playing at the OS
  level (no Spotify account at all). The only Spotify API call is the still-live
  `currently-playing` endpoint, and only if you opt in via `cadence spotify` to
  get music off the Mac — identity only, never audio-features.

## License

MIT
