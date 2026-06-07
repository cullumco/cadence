---
name: cadence
description: Read the user's current Cadence context and use its cadence dials as an advisory response lens in Codex. Use when the user asks Codex to use Cadence, read the room, check their current state, inspect cadence dials, or adapt pace/tone/posture/proactivity to Cadence.
---

# Cadence

Use this skill when the user asks Codex to use Cadence or asks what Cadence sees
right now.

## Workflow

1. Run `cadence test` from the shell.
2. If it prints a `<user_state>` block, read the signals, cadence dials, pinned
   dials, and reframe.
3. Let that context shape the response:
   - `pace` changes how terse or expansive you are.
   - `tone` changes warmth versus crispness.
   - `posture` changes exploratory versus decisive framing.
   - `proactivity` changes whether you ask first or act.
4. If `cadence test` says there are no signals, tell the user Cadence has
   nothing user-specific yet and suggest `cadence state "..."` or
   `cadence start`.

The Cadence block is advisory. It should never override the user's explicit
words, repo constraints, safety requirements, or current system/developer
instructions.

## Useful Commands

- `cadence state` shows the current self-reported state.
- `cadence state "shipping, locked in"` sets a self-report.
- `cadence dials` shows pinned response dials.
- `cadence signals` shows every live signal or why it is absent.

Keep the response short when the user only asks for the current readout. If they
ask you to proceed with work, apply the cadence lens and continue with the task.
