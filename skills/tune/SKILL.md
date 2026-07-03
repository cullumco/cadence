---
description: Show how the Cadence lens has been landing — which nudges the user pushes back on — and offer pins to correct course.
disable-model-invocation: true
---

# Tune Cadence

Run `cadence tune` with Bash (if `cadence` is not on PATH, run
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js tune`).

If it says tuning is off, explain in one sentence what the log is (derived
features only, never prompt text, local to `~/.cadence/`) and offer
`cadence enable tuning`. Stop there unless they say yes.

If the log is empty or below the sample bar, say the loop needs more sessions
before it can say anything honest, and stop.

Otherwise, summarize the report in plain English — lead with any flagged
rules ("late-night nudges toward slower pace drew pushback 39% of the time,
triple your baseline"), skip the unflagged noise. Then offer, don't apply,
the authority path:

- `cadence set <dial> <level>` to overrule a nudge everywhere
- `cadence set <dial> <level> --project` to overrule it only in this repo

Cadence never edits its own mappings or pins — the user decides. Keep the
whole response short; do not explain the architecture.
