# cadence

> Agents that read the room.
> Claude Code has one input channel: text. Cadence is the second.

A Claude Code hook that injects your current **embodied state** — what you're
listening to, what you told it, how you want it to respond — into every prompt,
then asks Claude to *read your prompt through that lens*. The agent stops being
deaf to the room.

A [Cullum&Co](https://cullum.co) project.

## What it does

Before Claude sees your prompt, Cadence injects a `<user_state>` block:

```
<user_state>
  signals:
    music: "Loose" — Daniel Caesar (Spotify)
    vibe: sexy, chilled
    self_report: "two beers, shipping"
  cadence:  # inferred from signals, advisory
    { pace=fast tone=warm posture=decisive proactivity=act-freely }
  reframe: read my prompt as someone in this cadence meant it: keep it fast and
    tight — answer first, trim the preamble; make the call rather than offering a
    menu of options; act without stopping to check in; keep the tone warm and
    casual. If my words clearly mean otherwise, follow my words.
</user_state>
```

It doesn't constrain Claude or rewrite your prompt — it gives Claude the context
your words are missing, and a lens for reading them. The lens always defers to
what you actually typed.

## How it works

**Signals → dials → a reframe lens.**

1. **Signals** — what Cadence can sense right now:
   - **ambient** — time of day, day of week, weather (opt-in), power state.
     Zero setup, works on every OS. The one signal that's always there:
     `context: friday afternoon, rainy`.
   - **music** — what's playing (via macOS now-playing, any player), turned into
     a clean *vibe* (mood words) via [MusicBrainz](https://musicbrainz.org). No
     Spotify login, no API key, no Premium.
   - **self-report** — what you tell it: `cadence state "two beers, shipping"`.
2. **Dials** — four independent knobs, each `low | medium | high`, inferred from
   the signals (or pinned by you):
   - **pace** — deliberate ↔ fast
   - **tone** — warm ↔ crisp
   - **posture** — exploratory ↔ decisive
   - **proactivity** — ask-first ↔ act-freely
3. **Reframe** — a sentence composed from the dials telling Claude how to *read*
   your prompt. Generated fresh each time; always ends "if my words clearly mean
   otherwise, follow my words."

The dials are independent on purpose — high-energy-but-mellow music can read as
"fast pace, warm tone," something a single ship/think/debug label could never
express.

## Requirements

- **macOS** (the now-playing reader uses AppleScript against Spotify.app /
  Music.app). The self-report and dials work everywhere; only the music signal
  is macOS-only.
- **Node 20+**
- Claude Code

## Install

```bash
git clone https://github.com/cullumco/cadence ~/cadence
cd ~/cadence
npm install
npm run build
npm link        # puts the `cadence` command on your PATH
```

### Wire it into Claude Code

Add to `~/.claude/settings.json` (or a project's `.claude/settings.json`).
Replace the path with where you cloned it:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/cadence/dist/hook.js" }
        ]
      }
    ]
  }
}
```

The hook has a ~1.5s budget and exits silently when it has nothing to say, so it
never blocks or slows a prompt.

### Music vibe (optional, macOS only)

Nothing to set up. If Spotify.app or Music.app is playing, Cadence reads the
track, looks the artist's vibe up on MusicBrainz once, and caches it forever at
`~/.cadence/vibe-cache.json`. If nothing's playing, the music signal is simply
absent.

## Daily use

```bash
cadence state "two beers, shipping"   # set self-reported state (expires in 4h)
cadence state                         # print current self-report
cadence clear                         # clear it
cadence test                          # preview exactly what the hook would inject
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

## What's next

See [`BACKLOG.md`](BACKLOG.md). Highlights:

- **More signals** — `git` (commit cadence, conflict state), typing tempo, wifi.
  Git is the highest-value one: it moves the dials from *what you said* to *what
  you're actually doing*.
- **After-the-fact injection** — refine the cadence mid-task (`PostToolUse`) and
  enforce it at the finish line (`Stop`), not just before the prompt.
- **Opt-in flavor providers** — horoscope, moon phase, for those who want them.

## Caveats

- **macOS-only music.** The now-playing reader is AppleScript. Other platforms
  get self-report + dials, just no music vibe.
- **Spotify's Web API is not used** and not needed — Spotify deprecated audio
  features for new apps (2024) and gated dev-mode behind Premium (2026). Cadence
  reads what's playing at the OS level instead.

## License

MIT
