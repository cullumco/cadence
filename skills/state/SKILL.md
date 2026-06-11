---
description: Set or inspect the user's Cadence self-report, such as "shipping", "thinking", or "tired but pushing".
disable-model-invocation: true
---

# Cadence State

Use this skill when the user invokes `/cadence:state`.

If `$ARGUMENTS` is non-empty:
- Run `cadence report "$ARGUMENTS"` with Bash.
- Then tell the user the self-report is set and will expire after four hours.
- Keep it to one short sentence.

If `$ARGUMENTS` is empty:
- Run `cadence report` with Bash.
- Tell the user the current self-report, or that none is set.

Do not explain the whole product.
