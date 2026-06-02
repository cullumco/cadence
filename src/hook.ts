#!/usr/bin/env node
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getAmbientSignal } from "./providers/ambient.js";
import { deriveCadence, buildReframe, loadOverrides, applyOverrides } from "./cadence.js";
import { render } from "./inject.js";
import type { Signal, UserState, StateWithCadence } from "./types.js";

const TOTAL_BUDGET_MS = 1500;

async function readStdin(): Promise<void> {
  if (process.stdin.isTTY) return;
  for await (const _ of process.stdin) {
    // drain — claude code writes hook input here; we don't currently use it
  }
}

async function collectSignals(): Promise<Signal[]> {
  const [music, report, ambient] = await Promise.allSettled([
    getMusicSignal(),
    getSelfReportSignal(),
    getAmbientSignal(new Date()),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (ambient.status === "fulfilled" && ambient.value) signals.push(ambient.value);
  return signals;
}

async function main() {
  await readStdin();

  const [signals, overrides] = await Promise.all([
    Promise.race<Signal[]>([
      collectSignals(),
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
