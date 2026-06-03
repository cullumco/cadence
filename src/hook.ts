#!/usr/bin/env node
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getAmbientSignal } from "./providers/ambient.js";
import { getGitSignal } from "./providers/git.js";
import { getActivitySignal } from "./providers/activity.js";
import { deriveCadence, buildReframe, loadOverrides, applyOverrides } from "./cadence.js";
import { render } from "./inject.js";
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
  const [music, report, ambient, git, activity] = await Promise.allSettled([
    getMusicSignal(),
    getSelfReportSignal(),
    getAmbientSignal(new Date()),
    getGitSignal(cwd),
    getActivitySignal(prompt),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (ambient.status === "fulfilled" && ambient.value) signals.push(ambient.value);
  if (git.status === "fulfilled" && git.value) signals.push(git.value);
  if (activity.status === "fulfilled" && activity.value) signals.push(activity.value);
  return signals;
}

async function main() {
  const { cwd, prompt } = await readStdin();
  const projectDir = cwd ?? process.cwd();

  const [signals, overrides] = await Promise.all([
    Promise.race<Signal[]>([
      collectSignals(projectDir, prompt),
      new Promise<Signal[]>((resolve) => setTimeout(() => resolve([]), TOTAL_BUDGET_MS)),
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

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
    })
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cadence: ${msg}\n`);
  process.exit(0);
});
