---
description: Show what Cadence is doing right now and give the user a quick way to feel the difference.
disable-model-invocation: true
---

# Try Cadence

When the user invokes this skill, make Cadence immediately legible.

If a `<user_state>` block is present in context:
- Briefly summarize the visible signals and cadence dials in plain English.
- Name one concrete way that cadence should change your response style.
- Give the user one tiny prompt to try next that would make the difference obvious.

If no `<user_state>` block is present:
- Run `cadence test` with Bash before diagnosing (if `cadence` is not on PATH,
  run `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js test`).
- If it says Cadence is paused, say that — paused is off, not broken — and
  point at `/cadence:resume`.
- Otherwise say Cadence does not appear to be injecting context in this
  session yet, and suggest checking the install or running `cadence signals`.

Keep the response short, warm, and practical. Do not explain the whole product.
