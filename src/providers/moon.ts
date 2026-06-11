import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MoonSignal, MoonPhase } from "../types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Moon phase — the first esoteric, opt-in provider (see BACKLOG).
 *
 * Pure offline math: phase from days since a known new moon, no API, no
 * platform dependency. OFF by default — it only speaks if the user opted in
 * via ~/.cadence/config.json:  { "providers": { "moon": true } }
 *
 * Render-only by design: esoteric signals color the vibe, they never move
 * dials unless the user explicitly maps them (BACKLOG: "vibe-only unless
 * the user maps them").
 * ───────────────────────────────────────────────────────────────────────── */

const CONFIG_FILE = join(homedir(), ".cadence", "config.json");

interface MoonConfig {
  providers?: { moon?: boolean };
}

// Mean synodic month. Anchor: the new moon of 2000-01-06 18:14 UTC.
// Mean-cycle math drifts up to ~14h from true phase — irrelevant at the
// "waxing gibbous" level of precision we render.
const SYNODIC_DAYS = 29.53058867;
const EPOCH_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

const PHASES: readonly MoonPhase[] = [
  "new",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full",
  "waning gibbous",
  "last quarter",
  "waning crescent",
];

// Pure and clock-injected so it's fixture-testable.
export function moonPhase(now: Date): { phase: MoonPhase; illumination: number } {
  const days = (now.getTime() - EPOCH_NEW_MOON_MS) / 86_400_000;
  const fraction = (((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS) / SYNODIC_DAYS;
  // Disc illumination: 0 at new (fraction 0), 100 at full (fraction 0.5).
  const illumination = Math.round((1 - Math.cos(2 * Math.PI * fraction)) * 50);
  // Eight equal buckets, centered on the cardinal points (new = ±1/16 around 0).
  const idx = Math.floor(((fraction + 1 / 16) % 1) * 8);
  return { phase: PHASES[idx] ?? "new", illumination };
}

export async function getMoonSignal(now: Date = new Date()): Promise<MoonSignal | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as MoonConfig;
    if (cfg.providers?.moon !== true) return null; // opt-in only, off by default
    return { source: "moon", ...moonPhase(now) };
  } catch {
    return null; // no config / bad JSON → simply off, never throw
  }
}
