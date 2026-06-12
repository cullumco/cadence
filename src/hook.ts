#!/usr/bin/env node
import { deriveCadence, buildReframe, loadOverrides, applyOverrides } from "./cadence.js";
import { loadProviders, isPaused } from "./config.js";
import { collectSignals } from "./envelope.js";
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

// Signal collection lives in envelope.ts — the shared seam every surface
// (hook, CLI preview, MCP server) reads through, so they can't drift apart.

async function main() {
  // Paused = the user asked for silence. Check FIRST: no signals read, no
  // subprocesses spawned, nothing injected. `cadence resume` turns it back on.
  if (await isPaused()) process.exit(0);

  const { cwd, prompt } = await readStdin();
  const projectDir = cwd ?? process.cwd();

  // Pins + the opt-in registry are tiny local reads; load them first so signal
  // collection knows which opt-in providers to run, then race only the
  // subprocess-heavy collection against the budget.
  const [overrides, providers] = await Promise.all([loadOverrides(), loadProviders()]);
  const signals = await Promise.race<Signal[]>([
    collectSignals(projectDir, prompt, providers),
    // unref: the losing timer must not hold the process open after the
    // race settles — Claude Code waits on our EXIT, not our output.
    new Promise<Signal[]>((resolve) =>
      setTimeout(() => {
        debug("hook", `signal collection exceeded ${TOTAL_BUDGET_MS}ms budget — injecting without signals`);
        resolve([]);
      }, TOTAL_BUDGET_MS).unref()
    ),
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
