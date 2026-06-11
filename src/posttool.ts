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
 * Two material events now, same discipline:
 *   1. the repo entering/leaving a merge/rebase conflict (re-observed via git)
 *   2. a streak of destructive git ops — reset --hard / force-push — read off
 *      the command string (no tool_response parsing), i.e. thrash.
 *
 * Discipline (the BACKLOG's hard constraint):
 *   - fires only after Bash tool calls whose command mentions git
 *   - injects at most once per TRANSITION (conflict edge, or thrash threshold),
 *     never per tool
 *   - silent in every other case, silent on every error
 * ───────────────────────────────────────────────────────────────────────── */

const TOTAL_BUDGET_MS = 1500;
const STATE_FILE = join(homedir(), ".cadence", "workstate.json");
const MAX_SESSIONS = 20;
const THRASH_WINDOW_MS = 10 * 60_000; // destructive ops within 10 min count as a streak
const THRASH_MIN = 2; // 2nd destructive op in the window = thrash

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

// Is this command a destructive/undo git op? Just `reset --hard` and a true
// force-push — NOT --force-with-lease (the safe one), checkout, or restore
// (too ordinary to read as thrash). Pure + exported for tests.
export function isThrashCommand(cmd: string): boolean {
  return (
    /git\s+reset\s+--hard\b/.test(cmd) ||
    (/git\s+push\b/.test(cmd) && /(--force\b|\s-f\b)/.test(cmd) && !/--force-with-lease\b/.test(cmd))
  );
}

/* Edge-trigger thrash off the rolling window of destructive-op timestamps.
 * Speaks once when the streak first crosses THRASH_MIN inside the window, then
 * stays quiet until the window empties (so it can fire again on a later run).
 * Pure + exported; `times` already includes the current op if it was one. */
export function refineThrash(
  times: number[],
  now: number,
  announced: boolean
): { message: string | null; times: number[]; announced: boolean } {
  const recent = times.filter((t) => now - t <= THRASH_WINDOW_MS);
  if (recent.length === 0) return { message: null, times: recent, announced: false };
  if (recent.length >= THRASH_MIN && !announced) {
    return {
      message:
        "<user_state_update>observed work: a streak of destructive git ops " +
        "(reset --hard / force-push). Read this as thrash — pause, verify the " +
        "repo state and what's being undone before the next destructive step. " +
        "If the user's words clearly mean otherwise, follow their words." +
        "</user_state_update>",
      times: recent,
      announced: true,
    };
  }
  return { message: null, times: recent, announced };
}

interface WorkEntry {
  conflicted: boolean;
  at: number;
  thrashTimes?: number[];
  thrashAnnounced?: boolean;
}
type WorkState = Record<string, WorkEntry>;

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
  const prev = state[key];
  const now = Date.now();

  // 1. conflict edge (re-observed via git)
  const conflictMsg = refineContext(prev?.conflicted, git.conflicted);

  // 2. thrash threshold (read off the command string)
  const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  const times = prev?.thrashTimes ?? [];
  const nextTimes = isThrashCommand(cmd) ? [...times, now] : times;
  const thrash = refineThrash(nextTimes, now, prev?.thrashAnnounced ?? false);

  state[key] = {
    conflicted: git.conflicted,
    at: now,
    thrashTimes: thrash.times,
    thrashAnnounced: thrash.announced,
  };
  await saveState(state);

  // A conflict edge is the stronger tell; fall back to thrash. At most one.
  const message = conflictMsg ?? thrash.message;
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
