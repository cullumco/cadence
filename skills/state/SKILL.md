---
name: cadence-state
description: Set or inspect the user's self-reported Cadence state, such as "shipping", "thinking", or "tired but pushing".
disable-model-invocation: false
---

# Cadence State

Use this skill when the user invokes `/cadence:state`.

If `$ARGUMENTS` is non-empty:
- Run `cadence report "$ARGUMENTS"` with Bash.
- Then tell the user the state is set and will expire after two hours.
- Keep it to one short sentence.

If `$ARGUMENTS` is empty:
- Run `cadence report` with Bash.
- Tell the user the current state, or that none is set.

Do not explain the whole product.
