---
description: Conversational Cadence setup — shape how the agent reads your prompts, choose which signals to share, all through a short conversation.
disable-model-invocation: true
---

# Cadence Setup

Walk the user through shaping Cadence conversationally. You orchestrate; the
`cadence` CLI is the source of truth — run commands with Bash, never edit
`~/.cadence/` files directly.

Have a short conversation, not a form. Adapt to their answers; skip anything
they don't care about. The arc:

1. **State** — ask how they're working right now (shipping? thinking through
   something? debugging? just vibing?). Phrase it naturally. Turn their answer
   into `cadence report "<their words>"`. Tell them it expires after 2 hours and
   they can refresh with `/cadence:state`.

2. **Dials** — ask if there's anything they ALWAYS want, regardless of signals
   (e.g. "always be terse", "never act without asking"). Map to pins:
   `cadence set pace|tone|posture|proactivity <low|medium|high>`. Most people
   should pin nothing — say so. Pins override inference until unset. If a want
   is repo-specific ("always terse in this repo", "ask first in prod infra"),
   add `--project` to pin it for the current directory only.

3. **Opt-in signals** — offer, one line each, that these are off until asked:
   - calendar (`cadence calendar set-url <ics-url>` — a secret Google/Outlook
     ICS link; setting the URL is the enablement) — "meeting in 12 min" →
     wrap-up pressure
   - typing tempo (`cadence enable typingTempo`) — prompt rhythm → pace
   - focused app (`cadence enable focusedApp`, macOS) — frontmost app as flavor
   - weather (`cadence set-location <lat> <lon>`) — needs a location
   - tuning (`cadence enable tuning`) — a private local log of how the lens
     lands, so `/cadence:tune` can report which nudges you push back on
   - moon / horoscope (`cadence enable moon`, `cadence enable horoscope <sign>`)
   - Spotify off-Mac (`cadence spotify connect <clientId>` — needs a terminal,
     opens a browser; just point them at it, don't run it)
   Enable only what they ask for.

4. **Show the result** — run `cadence test` and summarize the injected block in
   one or two plain-English sentences: what the agent now sees, and one way it
   will change responses.

Close by mentioning: `/cadence:pause` silences everything instantly,
`/cadence:resume` brings it back, and `cadence signals` shows every signal and
why it is or isn't firing.

Keep the whole exchange warm and fast — under a minute of their time. Do not
explain the architecture.
