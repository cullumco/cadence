#!/usr/bin/env node
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getEnvironmentSignal } from "./providers/environment.js";
import { getGitSignal } from "./providers/git.js";
import { getActivitySignal } from "./providers/activity.js";
import { getMoonSignal } from "./providers/moon.js";
import { deriveCadence, buildReframe, loadOverrides, applyOverrides } from "./cadence.js";
import { render } from "./inject.js";
import { debug } from "./debug.js";
import type { Signal, UserState, StateWithCadence } from "./types.js";

const TOTAL_BUDGET_MS = 1500;

// Claude Code alpha adapter: collect portable Cadence signals, derive the core
// cadence state, then deliver it through UserPromptSubmit.additionalContext.
// Keep Claude-specific payload/output details here so the core stays reusable.

// Claude Code writes a JSON payload to stdin; it includes `cwd` (the project
// dir). We read it so the git provider inspects the RIGHT repo, not wherever
// the hook binary happens to live.
async function readStdin(): Promise<{ cwd?: string; prompt?: string }> {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw) as { cwd?: string; prompt?: string };
  } catch {
    return {};
  }
}

async function collectSignals(cwd: string, prompt?: string): Promise<Signal[]> {
  const [music, report, environment, git, activity, moon] = await Promise.allSettled([
    getMusicSignal(),
    getSelfReportSignal(),
    getEnvironmentSignal(new Date()),
    getGitSignal(cwd),
    getActivitySignal(prompt),
    getMoonSignal(new Date()),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (environment.status === "fulfilled" && environment.value) signals.push(environment.value);
  if (git.status === "fulfilled" && git.value) signals.push(git.value);
  if (activity.status === "fulfilled" && activity.value) signals.push(activity.value);
  if (moon.status === "fulfilled" && moon.value) signals.push(moon.value);
  return signals;
}

async function main() {
  const { cwd, prompt } = await readStdin();
  const projectDir = cwd ?? process.cwd();

  const [signals, overrides] = await Promise.all([
    Promise.race<Signal[]>([
      collectSignals(projectDir, prompt),
      // unref: the losing timer must not hold the process open after the
      // race settles — Claude Code waits on our EXIT, not our output.
      new Promise<Signal[]>((resolve) =>
        setTimeout(() => {
          debug("hook", `signal collection exceeded ${TOTAL_BUDGET_MS}ms budget — injecting without signals`);
          resolve([]);
        }, TOTAL_BUDGET_MS).unref()
      ),
    ]),
    loadOverrides(),
  ]);

  // Nothing to say: no signals AND no pinned dials.
  if (signals.length === 0 && Object.keys(overrides).length === 0) {
    process.exit(0);
  }

  const state: UserState = { signals, capturedAt: Date.now() };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const reframe = buildReframe(cadence);
  const stateWithCadence: StateWithCadence = { ...state, cadence, pinned, reframe };
  const block = render(stateWithCadence);

  // Exit in the write callback (stdout to a pipe can flush async): a straggling
  // provider subprocess must never keep the user's prompt waiting on our exit.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
    }),
    () => process.exit(0)
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cadence: ${msg}\n`);
  process.exit(0);
});
