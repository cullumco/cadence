---
description: Read the user's current Cadence room (signals, cadence dials, reframe) and use it as an advisory response lens — for harnesses without prompt hooks, or when the user explicitly asks for a readout.
disable-model-invocation: true
---

# Cadence

Use this skill when the user explicitly asks to use Cadence, read the room, or
check what Cadence sees right now. In Claude Code the hooks already inject a
`<user_state>` block automatically — there, prefer the block already in
context; this skill is the manual path for harnesses without prompt hooks.

## Workflow

1. Run `cadence envelope` with Bash (if `cadence` is not on PATH, run
   `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js envelope`).
2. Empty output means there is nothing to inject — no signals and no pinned
   dials. Tell the user Cadence has nothing user-specific yet and suggest
   `cadence report "..."` or `cadence start`. A paused notice means Cadence is
   paused — say so and point at `/cadence:resume`; don't call it broken.
3. Otherwise read the signals, cadence dials, pinned dials, and reframe, and
   let them shape the response:
   - `pace` changes how terse or expansive you are.
   - `tone` changes warmth versus crispness.
   - `posture` changes exploratory versus decisive framing.
   - `proactivity` changes whether you ask first or act.

The Cadence block is advisory. It never overrides the user's explicit words,
repo constraints, safety requirements, or system/developer instructions.

## Useful Commands

- `cadence report` shows the current self-reported state.
- `cadence report "shipping, locked in"` sets a self-report.
- `cadence dials` shows pinned response dials.
- `cadence signals` shows every live signal or why it is absent.

Keep the response short when the user only asks for the current readout. If
they ask you to proceed with work, apply the cadence lens and continue with
the task.
