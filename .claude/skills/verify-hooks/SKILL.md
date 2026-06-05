---
name: verify-hooks
description: Smoke-test all Cadence hooks end-to-end against compiled dist/ with synthetic payloads. Use before releases, after hook changes, or when a hook misbehaves in a live session.
---

# Verify the hooks

All hooks read a JSON payload on stdin and write JSON (or nothing) on
stdout. Always `npm run build` first — hooks run from `dist/`.

## UserPromptSubmit (`dist/hook.js`)

```bash
echo '{"cwd":"'$PWD'","prompt":"test prompt"}' | node dist/hook.js
```
Expect `hookSpecificOutput.additionalContext` containing a `<user_state>`
block — or NOTHING when no signals and no pins exist (silent-when-empty is
a hard property; verify it stays silent with an empty `~/.cadence` if
touching that path). Budget: must return well under 1500ms.

## Stop (`dist/stop.js`)

```bash
# should block (shipping self-report + soft handoff):
cadence state "shipping, locked in"
echo '{"cwd":"'$PWD'","last_assistant_message":"Want me to do that next?"}' | node dist/stop.js
# should stay silent (no shipping authority):
cadence clear
echo '{"cwd":"'$PWD'","last_assistant_message":"Want me to do that next?"}' | node dist/stop.js
```
Restore the user's real state afterward (`cadence state "..."`).

## PostToolUse (`dist/posttool.js`)

Edge-triggered on conflict transitions; test with a real temp-repo merge:

```bash
T=$(mktemp -d) && cd "$T" && git init -q && git commit -q --allow-empty -m init \
  && echo a > f.txt && git add f.txt && git commit -qm a \
  && git checkout -qb other && echo b > f.txt && git commit -qam b \
  && git checkout -q - && echo c > f.txt && git commit -qam c \
  && (git merge other -q 2>/dev/null || true)
echo '{"session_id":"vh","cwd":"'$T'","tool_name":"Bash","tool_input":{"command":"git merge other"}}' \
  | node "$OLDPWD/dist/posttool.js"      # expect: "entered a merge/rebase conflict"
git checkout --theirs f.txt && git add f.txt && GIT_EDITOR=true git merge --continue
echo '{"session_id":"vh","cwd":"'$T'","tool_name":"Bash","tool_input":{"command":"git merge --continue"}}' \
  | node "$OLDPWD/dist/posttool.js"      # expect: "conflict is resolved"
rm -rf "$T"
```
Gotcha: `git merge --continue` rejects `-q`; use `GIT_EDITOR=true`.
Also verify silence: re-run the same payload twice → second run emits
nothing (transition dedup), and non-git Bash commands emit nothing.

## SessionStart (`dist/session-start.js`)

```bash
echo '{"cwd":"'$PWD'"}' | node dist/session-start.js
```

## Full gate

`npm run verify:alpha` packs the tarball and runs the installed hook binary
in a temp consumer project — the closest thing to a real plugin install.
Every hook must exit 0 on garbage stdin (`echo garbage | node dist/<hook>.js`).
