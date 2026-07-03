---
description: Pause Cadence — silence all hooks instantly; prompts go through untouched until resumed.
disable-model-invocation: true
allowed-tools: Bash(cadence pause)
---

# Pause Cadence

Run `cadence pause` with Bash.

Then confirm in one sentence: Cadence is paused, prompts go through untouched,
and `/cadence:resume` turns it back on. Their state (self-report, pins,
opt-ins) is preserved exactly as-is.

Note: the current session may already have `<user_state>` blocks in context
from earlier prompts — ignore them from here on; the user has asked for
silence.
