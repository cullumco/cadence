#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitSignal } from "./providers/git.js";

/* ─────────────────────────────────────────────────────────────────────────
 * PostToolUse adapter — V2 "after-the-fact" refinement, conservative cut.
 *
 * The UserPromptSubmit lens is predictive: it reads AMBIENT state before any
 * work happens. This hook watches the work itself and speaks only when the
 * observed work MATERIALLY changes the cadence read. V2's single material
 * event: the repo entering or leaving a merge/rebase conflict — the
 * strongest debug tell we have, far stronger than music ever was.
 *
 * Discipline (the BACKLOG's hard constraint):
 *   - fires only after Bash tool calls whose command mentions git
 *   - injects at most once per conflict-state TRANSITION, never per tool
 *   - silent in every other case, silent on every error
 * ───────────────────────────────────────────────────────────────────────── */

const TOTAL_BUDGET_MS = 1500;
const STATE_FILE = join(homedir(), ".cadence", "workstate.json");
const MAX_SESSIONS = 20;

interface PostToolInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { command?: unknown };
}

// Gate 1: is this tool call even capable of changing git conflict state?
// Only Bash commands that mention git — Edit/Read/etc. can't start a merge,
// and checking the repo after every tool call would betray the silence rule.
export function shouldCheck(input: PostToolInput): boolean {
  if (input.tool_name !== "Bash") return false;
  const cmd = input.tool_input?.command;
  return typeof cmd === "string" && /\bgit\b/.test(cmd);
}

// Gate 2: did the observed state actually TRANSITION? Speak only on the edge.
//   undefined → true   first observation reveals a conflict → speak
//   false     → true   work just entered a conflict          → speak
//   true      → false  conflict resolved                     → speak (release)
//   anything else      no change                             → silent
export function refineContext(
  prev: boolean | undefined,
  conflicted: boolean
): string | null {
  if (prev === conflicted) return null;
  if (conflicted) {
    return (
      "<user_state_update>observed work: the repo just entered a merge/rebase " +
      "conflict. Read the cadence as debug now — verify the repo state, lead " +
      "with hypotheses, and don't barrel toward shipping until it's resolved. " +
      "If the user's words clearly mean otherwise, follow their words.</user_state_update>"
    );
  }
  if (prev === true) {
    return (
      "<user_state_update>observed work: the conflict is resolved — drop the " +
      "debug framing and return to the user's prior cadence.</user_state_update>"
    );
  }
  return null; // first observation of a clean repo: record silently
}

type WorkState = Record<string, { conflicted: boolean; at: number }>;

async function loadState(): Promise<WorkState> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf-8")) as WorkState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function saveState(state: WorkState): Promise<void> {
  try {
    // prune to the newest MAX_SESSIONS so the file can't grow unbounded
    const entries = Object.entries(state)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_SESSIONS);
    await mkdir(join(homedir(), ".cadence"), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(Object.fromEntries(entries)), "utf-8");
  } catch {
    // best-effort; a failed save just means we might speak twice
  }
}

async function readStdin(): Promise<PostToolInput> {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw) as PostToolInput;
  } catch {
    return {};
  }
}

async function main() {
  const input = await readStdin();
  if (!shouldCheck(input)) return;

  const git = await Promise.race([
    getGitSignal(input.cwd ?? process.cwd()).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TOTAL_BUDGET_MS)),
  ]);
  if (!git) return; // not a repo / git unavailable → nothing to observe

  const key = input.session_id ?? "default";
  const state = await loadState();
  const prev = state[key]?.conflicted;
  const message = refineContext(prev, git.conflicted);

  state[key] = { conflicted: git.conflicted, at: Date.now() };
  await saveState(state);

  if (message) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: message,
        },
      })
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cadence posttool: ${msg}\n`);
    process.exit(0); // never block the tool loop
  });
}
