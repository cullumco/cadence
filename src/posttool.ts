#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitSignal } from "./providers/git.js";
import { isPaused } from "./config.js";

/* ─────────────────────────────────────────────────────────────────────────
 * PostToolUse adapter — V2 "after-the-fact" refinement, conservative cut.
 *
 * The UserPromptSubmit lens is predictive: it reads AMBIENT state before any
 * work happens. This hook watches the work itself and speaks only when the
 * observed work MATERIALLY changes the cadence read. V2's single material
 * event: the repo entering or leaving a merge/rebase conflict — the
 * strongest debug tell we have, far stronger than music ever was.
 *
 * Three material events now, same discipline:
 *   1. the repo entering/leaving a merge/rebase conflict (re-observed via git)
 *   2. a streak of destructive git ops — reset --hard / force-push — read off
 *      the command string (no tool_response parsing), i.e. thrash.
 *   3. the test suite entering/leaving a failing state — read off the output
 *      of test-runner commands, tri-state honest (can't tell → don't update).
 *
 * Discipline (the BACKLOG's hard constraint):
 *   - fires only after Bash tool calls whose command mentions git or a test run
 *   - injects at most once per TRANSITION (conflict edge, thrash threshold,
 *     or tests-failing edge), never per tool
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
  tool_response?: unknown;
}

// Does this command run a test suite? Phrase-based like intent.ts — runner
// names and `npm test`-shaped invocations, not the bare word "test" (which
// would match `git stash list | grep test`). Pure + exported for tests.
export function isTestCommand(cmd: string): boolean {
  return (
    /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b/.test(cmd) ||
    /\bnode\s+--test\b/.test(cmd) ||
    /\b(?:jest|vitest|mocha|pytest|tape|ava)\b/.test(cmd) ||
    /\bgo\s+test\b/.test(cmd) ||
    /\bcargo\s+test\b/.test(cmd)
  );
}

// Gate 1: is this tool call even capable of changing what we observe?
// Only Bash commands that mention git (conflict/thrash) or run tests —
// checking after every tool call would betray the silence rule.
export function shouldCheck(input: PostToolInput): boolean {
  if (input.tool_name !== "Bash") return false;
  const cmd = input.tool_input?.command;
  if (typeof cmd !== "string") return false;
  return /\bgit\b/.test(cmd) || isTestCommand(cmd);
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

/* Did the test run fail? Tri-state honest, read off the runner's own summary:
 *   true       a nonzero failure count, or an unambiguous failure marker
 *   false      an explicit zero-failure count, or passes with no failure marks
 *   undefined  can't tell → caller must NOT update state (couldn't look ≠ ok)
 * Counts beat markers: "✖ 0 failing" is a pass even though ✖ appears. */
export function testsFailedFrom(resp: unknown): boolean | undefined {
  if (resp == null) return undefined;
  const text = typeof resp === "string" ? resp : JSON.stringify(resp);
  if (!text) return undefined;

  // explicit counts, either word order: "2 failed" / "fail 2" / "failures: 0"
  const counts = [
    ...text.matchAll(/(\d+)\s*(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/gi),
    ...text.matchAll(/\bfail(?:ed|ing|ures?)?[:\s]+(\d+)/gi),
  ].map((m) => Number(m[1]));
  if (counts.some((n) => n > 0)) return true;
  if (counts.length > 0) return false;

  // unambiguous markers (go test FAIL, TAP "not ok", node/jest ✖ lists)
  if (/\bFAIL(?:ED)?\b/.test(text) || /\bnot ok\b/.test(text) || /✖/.test(text)) return true;
  // passes with no failure marks anywhere
  if (/\b\d+\s+pass(?:ed|ing)?\b/i.test(text) || /\bok\b/.test(text)) return false;
  return undefined;
}

// Same edge contract as refineContext, for the tests-failing state.
export function refineTests(
  prev: boolean | undefined,
  failing: boolean
): string | null {
  if (prev === failing) return null;
  if (failing) {
    return (
      "<user_state_update>observed work: the test suite just started failing. " +
      "Read the cadence as debug now — verify before building further, and " +
      "treat the failures as the current ground truth. If the user's words " +
      "clearly mean otherwise, follow their words.</user_state_update>"
    );
  }
  if (prev === true) {
    return (
      "<user_state_update>observed work: the tests are passing again — drop " +
      "the debug framing and return to the user's prior cadence.</user_state_update>"
    );
  }
  return null; // first observation of a passing suite: record silently
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
  testsFailing?: boolean;
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
  if (await isPaused()) return; // user asked for silence — observe nothing
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
  const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

  // 1. conflict edge (re-observed via git)
  const conflictMsg = refineContext(prev?.conflicted, git.conflicted);

  // 2. tests-failing edge (read off the runner's output; tri-state honest —
  //    an unreadable run keeps the previous observation, it never clears it)
  const failed = isTestCommand(cmd) ? testsFailedFrom(input.tool_response) : undefined;
  const testsFailing = failed ?? prev?.testsFailing;
  const testsMsg = failed != null ? refineTests(prev?.testsFailing, failed) : null;

  // 3. thrash threshold (read off the command string)
  const times = prev?.thrashTimes ?? [];
  const nextTimes = isThrashCommand(cmd) ? [...times, now] : times;
  const thrash = refineThrash(nextTimes, now, prev?.thrashAnnounced ?? false);

  state[key] = {
    conflicted: git.conflicted,
    at: now,
    thrashTimes: thrash.times,
    thrashAnnounced: thrash.announced,
    ...(testsFailing != null ? { testsFailing } : {}),
  };
  await saveState(state);

  // Strongest tell wins: conflict > tests > thrash. At most one message.
  const message = conflictMsg ?? testsMsg ?? thrash.message;
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
