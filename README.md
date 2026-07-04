# cadence

> Agents that read the room.
> Claude Code has one input channel: text. Cadence is the second.

Cadence is an ambient context layer for agents. The current alpha surface is a
Claude Code hook: it injects your current **embodied state** — what you're
listening to, what you told it, how you want it to respond — into every prompt,
then asks Claude to *read your prompt through that lens*. The agent stops being
deaf to the room.

**Richest signals on macOS; universal signals everywhere.** The deepest
ambient probes read the Mac around you. Every platform gets the dial-movers —
prompt intent, self-report, git, time/day, typing tempo — and can link Spotify
for music (`cadence spotify connect`). The Mac-only probes degrade silently
off macOS — a contract CI tests on Linux on every push.

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
it" earlier in your prompt (or `cadence report "ship mode"`) →
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
   - **environment** — time of day, day of week, weather (opt-in), battery, machine
     uptime/load, dark mode, displays, wifi (opt-in), Focus/DND. Mostly zero-setup;
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
   - **self-report** — what you tell it: `cadence report "two beers, shipping"`.
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

- **Richest signals on macOS.** The deepest ambient probes — music via
  AppleScript now-playing, battery, dark mode, displays, wifi (opt-in),
  Focus/DND, focused app — read the Mac around you. On Linux, music comes in
  via MPRIS (`playerctl`, covers Spotify and most players) and battery via
  `/sys/class/power_supply` — both degrade silently if unavailable. On other
  platforms Cadence still runs and still moves the dials: prompt intent,
  self-report, git, time/day, and typing tempo work anywhere, Spotify can be
  linked for music, and the platform-only probes degrade silently (CI runs the
  suite on Linux to keep that true).
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

In Codex, the alpha surface is skill-driven rather than automatic prompt hooks:

```text
Install the Cadence Codex plugin, then ask:
Use Cadence to read the room.
```

The Codex plugin exposes the same `cadence` CLI-backed readout and state skills,
but does not receive Cadence through Claude-style prompt lifecycle hooks. Ask
Codex to use Cadence, or invoke the Cadence skill, and it will run `cadence test`
and shape the reply from the current dials.

Set a self-report so you can feel the difference:

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
cadence                                # the live instrument: dials, meters, readout (q quits)
cadence report "two beers, shipping"   # set self-reported state (expires in 2h)
cadence report                         # print current self-report
cadence clear                         # clear it
cadence test                          # preview exactly what the hook would inject
cadence signals                       # every signal — live value, or why it's absent
cadence pause                         # silence all hooks (state survives untouched)
cadence resume                        # start reading the room again
```

Bare `cadence` in a terminal opens the live instrument — four dial faders,
signal meters, and the reframe readout, refreshed every 2s. Piped or in CI it
prints the same static status it always has; `cadence --plain` forces the
static view in a terminal.

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
/cadence:tune                     # how has the lens been landing? (needs tuning on)
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

Pins can be scoped to a project — "always terse in this repo, ask-first in
prod infra":

```bash
cadence set proactivity low --project   # pin for the current directory tree only
cadence projects                        # list project pins (marks the one that applies here)
cadence projects clear                  # clear them
```

Project pins live in *your* `~/.cadence/config.json`, never in repo files — a
cloned repo can't grant itself authority. Precedence: global pins → project
pins → env vars.

### The tune loop (opt-in): does the lens actually land?

```bash
cadence enable tuning     # start the local log (derived features only, never text)
cadence tune              # per-rule report: which nudges do you push back on?
```

With tuning on, Cadence logs how each prompt landed against the lens and
attributes pushback to the exact rule that nudged — "`env.late` fired 23×,
pushback followed 39% of the time vs 13% baseline — consider softening." Flags
require real sample sizes and must beat your baseline, so one grumpy week
indicts nothing. The report only ever *suggests* pins (`cadence set …`);
Cadence never edits its own mappings. Inside Claude Code, `/cadence:tune`
reads the report for you.

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
`Stop` hooks. Codex now has a skill-based adapter that reads the same state on
demand. The core signal types, cadence derivation, reframe lens, and rendering
are kept separate so future adapters can deliver the same cadence state through
other agent surfaces.

## Use Cadence with any agent

`cadence envelope` is the official generic integration primitive: it prints the
exact `<user_state>` block the Claude Code hook injects — or *nothing at all* —
so any agent harness with a pre-prompt hook can adopt Cadence in one line: run
`cadence envelope` and prepend its stdout to the prompt.

The contract is designed so you can inject stdout verbatim, blindly:

- **Empty stdout means inject nothing.** No signals and no pinned dials → no
  output, exit 0 — the hook's silent-when-empty behavior for free.
- **It never exits nonzero for signal failures**, and collection is bounded
  (~2s), so a broken probe can't wedge or fail your prompt path.
- **Paused is honest**: `cadence pause` makes it print a one-line paused
  notice instead of a stale room.
- **It's a pure read** — no `~/.cadence` writes, same read surface as the MCP
  server.

`cadence envelope --json` prints the structured state instead (signals, the
four dials, pinned, reframe) for harnesses that want to template it themselves.

Concrete non-Claude example — wrapping [`llm`](https://llm.datasette.io) (or
any prompt-taking CLI) so it reads the room first:

```bash
#!/usr/bin/env bash
# ask — same prompt, different room, any model
room="$(cadence envelope)"
if [ -n "$room" ]; then
  llm "$(printf '%s\n\n%s' "$room" "$*")"
else
  llm "$*"
fi
```

The same pattern fits any harness with a pre-prompt/context hook: shell out to
`cadence envelope`, prepend stdout. (Inside Claude Code you don't need it — the
plugin's hooks already inject the room.)

## Same room in Claude Desktop (MCP)

`cadence mcp` runs a zero-dependency MCP stdio server exposing the same
`<user_state>` block as a `cadence://user-state` resource (plus a JSON twin,
`cadence://envelope`) and a `get_user_state` tool. Claude Desktop
(Settings → Developer → Edit Config, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cadence": {
      "command": "npx",
      "args": ["-y", "@cullumco/cadence", "mcp"]
    }
  }
}
```

(If you installed globally, `"command": "cadence", "args": ["mcp"]` skips the
npx cold start. Cursor and other stdio MCP clients take the same command.)

Every read collects fresh signals — no cache, bounded at 2s. Notes:

- **Don't add it inside Claude Code** — the hooks already inject the room
  there; the MCP server would double it.
- The desktop room is shallower than the Claude Code one: no live prompt means
  no intent signal, and a desktop-launched server usually has a non-repo cwd,
  so git is typically absent.
- claude.ai *web* can't connect: web only speaks remote servers, and your
  signals live on your machine.
- `cadence pause` silences this surface too (reads answer with an honest
  "paused" text rather than a stale room).

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
  separate `cadence report` step.
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
    iPhone-synced Focus leaves no local trace and stays undetectable. *New:*
    a manually flipped Focus (the gesture, never a scheduled window) nudges
    proactivity high — heads-down means fewer check-ins. Weakest tier: git,
    intent, and self-report all override it.
- **Calendar proximity** — *shipped (opt-in):* paste your calendar's secret
  ICS feed URL (`cadence calendar set-url <url>`) and "next event in 12m"
  becomes wrap-up pressure — an event ≤15 min out tightens pace + posture.
  Minutes-only by default; event titles are a separate sub-opt-in
  (`cadence calendar titles on`). v1 parser skips recurring (RRULE) and
  all-day events. Calendar *density* (how packed the day is) stays
  intentionally unbuilt: Cadence targets solo builders deep in a project,
  not people racing between meetings.
- **After-the-fact injection** — shipped: a `PostToolUse` hook watches git-ish
  commands and speaks once per transition — entering/leaving a merge/rebase
  conflict, and destructive-op thrash (reset --hard streaks, force-pushes).
  Next material event: failing-test transitions.
- **The learning loop** — *shipped (opt-in, report-only):* `cadence enable
  tuning` starts a local log of derived features (never text); `cadence tune`
  attributes next-prompt pushback to the exact rule that nudged, with
  sample-size and baseline honesty. Suggests pins; never edits its own
  mappings. Auto-dampening stays deliberately unbuilt until the report earns
  trust.
- **Per-project pins** — *shipped:* `cadence set <dial> <level> --project`
  scopes a pin to the current directory tree (deepest match wins per dial).
  Stored in your config, never in repo files, so authority stays with you.

## Caveats

- **Richest signals on macOS.** The deepest ambient probes (music-via-OS,
  battery, dark mode, displays, wifi (opt-in), Focus, focused app) are macOS.
  Linux gets music (MPRIS via `playerctl`) and battery (sysfs). Other platforms
  keep the universal dial-movers — intent, self-report, git, time/day, typing
  tempo, linked Spotify — and the rest degrades silently.
- **Spotify's audio-features API is not used** — Spotify deprecated it for new
  apps (2024) and gated dev-mode behind Premium (2026), so vibe comes from
  MusicBrainz, not Spotify. On macOS, Cadence reads what's playing at the OS
  level (no Spotify account at all). The only Spotify API call is the still-live
  `currently-playing` endpoint, and only if you opt in via `cadence spotify` to
  get music off the Mac — identity only, never audio-features.

## License

MIT
