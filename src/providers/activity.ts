import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivitySignal } from "../types.js";

const CADENCE_DIR = join(homedir(), ".cadence");
const ACTIVITY_FILE = join(CADENCE_DIR, "activity.json");

// Rolling window for typing tempo: how many recent prompts we keep, and how
// far back they still count toward a "rapid-fire" read.
const WINDOW_MAX = 10;
const WINDOW_AGE_MS = 10 * 60_000; // 10 min — older prompts are a different sitting
const BURST_WINDOW_MS = 5 * 60_000; // ≥3 prompts inside 5 min = a burst
const BURST_MIN_PROMPTS = 3;
// Exported: learn.ts buckets logged prompt lengths with the SAME thresholds,
// so the tune log and the tempo read never disagree about what "short" means.
export const SHORT_PROMPT = 80; // median chars under this, in a burst → "rapid"
export const LONG_PROMPT = 280; // one prompt over this → "considered"

interface PromptMark {
  at: number;
  len: number;
}
interface ActivityState {
  lastPromptAt?: number;
  recent?: PromptMark[];
}

/* Tempo from the prompt-rhythm window. Pure + exported for fixture tests.
 * "considered" wins outright (a long prompt is deliberate even mid-burst);
 * otherwise a tight cluster of short prompts reads as "rapid". */
export function computeTempo(window: PromptMark[]): ActivitySignal["tempo"] {
  if (window.length === 0) return undefined;
  const current = window[window.length - 1]!;
  if (current.len > LONG_PROMPT) return "considered";
  const newest = current.at;
  const inBurst = window.filter((m) => newest - m.at <= BURST_WINDOW_MS);
  if (inBurst.length >= BURST_MIN_PROMPTS) {
    const lens = inBurst.map((m) => m.len).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)] ?? 0;
    if (median < SHORT_PROMPT) return "rapid";
  }
  if (window.length >= 2) return "measured";
  return undefined; // not enough rhythm yet to call it
}

export function activityFrom(
  prompt: string | undefined,
  lastPromptAt: number | undefined,
  now: number,
  recent: PromptMark[] = [],
  tempoEnabled = false
): ActivitySignal | null {
  if (prompt == null) return null;
  const signal: ActivitySignal = {
    source: "activity",
    promptLength: prompt.length,
  };
  if (lastPromptAt != null && Number.isFinite(lastPromptAt)) {
    signal.minSinceLastPrompt = Math.max(0, Math.round((now - lastPromptAt) / 60000));
  }
  if (tempoEnabled) {
    const window = [...recent, { at: now, len: prompt.length }].filter(
      (m) => now - m.at <= WINDOW_AGE_MS
    );
    const tempo = computeTempo(window);
    if (tempo) signal.tempo = tempo;
  }
  return signal;
}

export async function getActivitySignal(
  prompt: string | undefined,
  now: number = Date.now(),
  opts: { tempoEnabled?: boolean } = {}
): Promise<ActivitySignal | null> {
  let state: ActivityState = {};
  try {
    state = JSON.parse(await readFile(ACTIVITY_FILE, "utf-8")) as ActivityState;
  } catch {
    // no activity file yet
  }

  const recent = Array.isArray(state.recent) ? state.recent : [];
  const signal = activityFrom(prompt, state.lastPromptAt, now, recent, opts.tempoEnabled);

  try {
    await mkdir(CADENCE_DIR, { recursive: true });
    const nextRecent =
      prompt == null
        ? recent
        : [...recent, { at: now, len: prompt.length }]
            .filter((m) => now - m.at <= WINDOW_AGE_MS)
            .slice(-WINDOW_MAX);
    await writeFile(
      ACTIVITY_FILE,
      JSON.stringify({ lastPromptAt: now, recent: nextRecent }),
      "utf-8"
    );
  } catch {
    // activity is best-effort; never let it break the hook
  }

  return signal;
}
