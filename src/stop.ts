#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getEnvironmentSignal } from "./providers/environment.js";
import { getGitSignal } from "./providers/git.js";
import { deriveCadence, loadOverrides, applyOverrides } from "./cadence.js";
import { SHIP_PATTERN } from "./dj.js";
import { isPaused } from "./config.js";
import type { Cadence, Signal, UserState } from "./types.js";

const TOTAL_BUDGET_MS = 1500;

// Claude Code alpha adapter: turn portable Cadence state into a conservative
// Stop decision. The policy functions below stay exportable/testable so other
// adapters can reuse the same finish-line behavior.

interface StopInput {
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
}

export interface StopDecision {
  decision: "block";
  reason: string;
}

async function readStdin(): Promise<StopInput> {
  if (process.stdin.isTTY) return {};
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw) as StopInput;
  } catch {
    return {};
  }
}

async function collectSignals(cwd: string): Promise<Signal[]> {
  const [music, report, environment, git] = await Promise.allSettled([
    getMusicSignal(),
    getSelfReportSignal(),
    getEnvironmentSignal(new Date()),
    getGitSignal(cwd),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (environment.status === "fulfilled" && environment.value) signals.push(environment.value);
  if (git.status === "fulfilled" && git.value) signals.push(git.value);
  return signals;
}

function selfReportIsShipping(signals: Signal[]): boolean {
  const report = signals.find((s) => s.source === "self_report");
  if (!report) return false;
  // single source shared with the DJ ship trigger (src/dj.ts) — Stop
  // authority and DJ actuation must never drift apart on what "shipping" is
  return SHIP_PATTERN.test(report.text);
}

function pinnedActFreely(cadence: Cadence, pinned: (keyof Cadence)[]): boolean {
  return (
    (pinned.includes("proactivity") && cadence.proactivity === "high") ||
    (pinned.includes("posture") && cadence.posture === "high")
  );
}

function hasShippingAuthority(
  signals: Signal[],
  cadence: Cadence,
  pinned: (keyof Cadence)[]
): boolean {
  return selfReportIsShipping(signals) || pinnedActFreely(cadence, pinned);
}

export function isSoftHandoff(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;

  const tail = text.slice(-900);
  const finalParagraph = tail.split(/\n\s*\n/).at(-1) ?? tail;

  const permissionQuestion =
    /\b(?:do you want|would you like|want me to|should i|shall i|can i|would you prefer|should we)\b/.test(
      finalParagraph
    ) && /\?\s*$/.test(finalParagraph);

  const passiveOffer =
    /\b(?:let me know if|tell me if|say the word|if you want,? i can|if you'd like,? i can|happy to keep going|happy to do that next)\b/.test(
      finalParagraph
    );

  return permissionQuestion || passiveOffer;
}

export function decideStop(
  input: StopInput,
  signals: Signal[],
  cadence: Cadence,
  pinned: (keyof Cadence)[]
): StopDecision | null {
  if (input.stop_hook_active) return null;
  if (input.background_tasks && input.background_tasks.length > 0) return null;
  if (!hasShippingAuthority(signals, cadence, pinned)) return null;
  if (!isSoftHandoff(input.last_assistant_message ?? "")) return null;

  return {
    decision: "block",
    reason:
      "Cadence stop check: the user is in a shipping / act-freely cadence, but your last response ended as a soft handoff. Continue instead: make the call and complete the most likely next step, or if no tool work remains, replace the handoff with a decisive final answer. Do not ask permission unless there is a genuine blocker.",
  };
}

async function main() {
  if (await isPaused()) return; // user asked for silence — never block while paused
  const input = await readStdin();
  const projectDir = input.cwd ?? process.cwd();
  const [signals, overrides] = await Promise.all([
    Promise.race<Signal[]>([
      collectSignals(projectDir),
      new Promise<Signal[]>((resolve) => setTimeout(() => resolve([]), TOTAL_BUDGET_MS).unref()),
    ]),
    // cwd scopes project pins — a project-pinned proactivity/posture=high is
    // explicit user authority for THIS directory, so it counts as `pinned`
    // in the shipping-authority check exactly like a global pin.
    loadOverrides(projectDir),
  ]);

  const state: UserState = { signals, capturedAt: Date.now() };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const decision = decideStop(input, signals, cadence, pinned);
  if (decision) process.stdout.write(JSON.stringify(decision));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`cadence stop: ${msg}\n`);
    process.exit(0);
  });
}
