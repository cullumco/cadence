import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivitySignal } from "../types.js";

const CADENCE_DIR = join(homedir(), ".cadence");
const ACTIVITY_FILE = join(CADENCE_DIR, "activity.json");

interface ActivityState {
  lastPromptAt?: number;
}

export function activityFrom(
  prompt: string | undefined,
  lastPromptAt: number | undefined,
  now: number
): ActivitySignal | null {
  if (prompt == null) return null;
  const signal: ActivitySignal = {
    source: "activity",
    promptLength: prompt.length,
  };
  if (lastPromptAt != null && Number.isFinite(lastPromptAt)) {
    signal.minSinceLastPrompt = Math.max(0, Math.round((now - lastPromptAt) / 60000));
  }
  return signal;
}

export async function getActivitySignal(
  prompt: string | undefined,
  now: number = Date.now()
): Promise<ActivitySignal | null> {
  let state: ActivityState = {};
  try {
    state = JSON.parse(await readFile(ACTIVITY_FILE, "utf-8")) as ActivityState;
  } catch {
    // no activity file yet
  }

  const signal = activityFrom(prompt, state.lastPromptAt, now);

  try {
    await mkdir(CADENCE_DIR, { recursive: true });
    await writeFile(ACTIVITY_FILE, JSON.stringify({ lastPromptAt: now }), "utf-8");
  } catch {
    // activity is best-effort; never let it break the hook
  }

  return signal;
}
