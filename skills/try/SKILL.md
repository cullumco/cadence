---
name: cadence-try
description: Show what Cadence is doing right now and give the user a quick way to feel the difference.
disable-model-invocation: false
---

# Try Cadence

When the user invokes this skill, make Cadence immediately legible.

If a `<user_state>` block is present in context:
- Briefly summarize the visible signals and cadence dials in plain English.
- Name one concrete way that cadence should change your response style.
- Give the user one tiny prompt to try next that would make the difference obvious.

If no `<user_state>` block is present:
- Say Cadence does not appear to be injecting context in this session yet.
- Tell the user to install/enable the plugin or run `cadence test` from the shell.

Keep the response short, warm, and practical. Do not explain the whole product.
