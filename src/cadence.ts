import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  UserState,
  Cadence,
  DialLevel,
  MusicSignal,
  SelfReportSignal,
  GitSignal,
  ActivitySignal,
  EnvironmentSignal,
} from "./types.js";

export const DIALS = ["pace", "tone", "posture", "proactivity"] as const;
const LEVELS: DialLevel[] = ["low", "medium", "high"];

/* Shipping authority (see CONTEXT.md): the ship-pattern words a self-report
 * must contain to count as explicit permission to act decisively. Shared with
 * the Stop hook — keep it ONE pattern so dial nudging and stop blocking can't
 * drift apart. Deliberately unambiguous tokens only; no bare "just". */
export const SHIP_PATTERN = /\b(ship|shipping|jamming|locked.?in|sending|grind|send it)\b/i;

/* ─────────────────────────────────────────────────────────────────────────
 * SCOTT — this is now THE file (it replaced mode.ts).
 *
 * Instead of collapsing everything into ship/think/debug, Cadence drives four
 * INDEPENDENT dials. deriveCadence() is where your taste decides which signal
 * moves which dial. That's the personality of the product.
 *
 * The dials (each low | medium | high):
 *   pace        how fast/terse vs deliberate/expansive the reply should be
 *   tone        warm/casual vs crisp/professional voice
 *   posture     exploratory (options, tradeoffs) vs decisive (make the call)
 *   proactivity ask-before-acting vs act-without-checking-in
 *
 * Signals you can read (any subset present):
 *   report   { text }                  ← you said it; trust it most
 *   music    { vibe, energy }          ← energy 0–1 drives pace; vibe colors tone
 *   git      { commitsLastHour, ... }  ← work rhythm (when the provider lands)
 *   activity { minSinceLastPrompt, promptLength }
 *
 * A working baseline is below so it runs end-to-end. The mapping is yours.
 * ───────────────────────────────────────────────────────────────────────── */

// Human-facing word for each dial at each level (rendered in the block).
export const DIAL_WORDS: Record<keyof Cadence, Record<DialLevel, string>> = {
  pace: { low: "deliberate", medium: "steady", high: "fast" },
  tone: { low: "warm", medium: "neutral", high: "crisp" },
  posture: { low: "exploratory", medium: "balanced", high: "decisive" },
  proactivity: { low: "ask-first", medium: "balanced", high: "act-freely" },
};

export function deriveCadence(state: UserState): Cadence {
  const music = state.signals.find((s): s is MusicSignal => s.source === "music");
  const report = state.signals.find(
    (s): s is SelfReportSignal => s.source === "self_report"
  );
  const git = state.signals.find((s): s is GitSignal => s.source === "git");
  const activity = state.signals.find(
    (s): s is ActivitySignal => s.source === "activity"
  );
  const environment = state.signals.find(
    (s): s is EnvironmentSignal => s.source === "environment"
  );

  // Start neutral; each signal nudges individual dials.
  const c: Cadence = {
    pace: "medium",
    tone: "medium",
    posture: "medium",
    proactivity: "medium",
  };

  // ── environment → soft nudges FIRST (weakest), so stronger signals below win ──
  // Atmosphere, not orders: it colors the default, then music/self-report/git
  // can override. "It's late" shouldn't beat "I'm shipping."
  if (environment) {
    if (environment.hour >= 22 || environment.hour < 6) c.pace = "low"; // late → gentler
    if (environment.partOfDay === "early morning") c.pace = "low"; // easing in
    if (environment.isWeekend) c.tone = "low"; // looser on weekends
    if (environment.weather && /rain|snow|fog|storm|cloud/.test(environment.weather)) {
      c.tone = "low"; // gloomy out → warmer in
    }
    if (environment.onBattery) c.pace = "high"; // mobile/untethered → quick hits
  }

  // ── music energy → pace (only pace; leave tone/posture to other signals) ──
  if (music?.energy != null) {
    if (music.energy >= 0.7) c.pace = "high";
    else if (music.energy <= 0.4) c.pace = "low";
  }
  // mellow/organic vibe words warm the tone
  if (music?.vibe && /\b(calm|chilled|ethereal|romantic|warm)\b/.test(music.vibe)) {
    c.tone = "low";
  }

  // ── git → pace / proactivity (what you're DOING, not what you said) ───────
  // Enabled 2026-06-05 after the render-only git signal proved trustworthy.
  // Applied below self-report on purpose: "I'm shipping" beats a mid-conflict
  // read — the user's explicit word stays the higher authority.
  if (git) {
    if (git.commitsLastHour >= 3) c.pace = "high"; // flow state
    if (git.conflicted) c.proactivity = "low"; // verify, don't barrel
  }

  // ── self-report → posture / proactivity / tone (you know your state) ──────
  if (report) {
    const t = report.text.toLowerCase();
    if (SHIP_PATTERN.test(t)) {
      c.posture = "high";
      c.proactivity = "high";
      c.pace = "high";
    }
    if (/\b(think|thinking|exploring|planning|deciding|tradeoff|figuring|weigh)\b/.test(t)) {
      c.posture = "low";
      c.pace = "low";
    }
    if (/\b(stuck|broken|confused|debug|wtf|borked|why)\b/.test(t)) {
      c.posture = "low"; // lead with hypotheses, don't take framing at face value
      c.proactivity = "low"; // verify before acting
    }
    if (/\b(beers?|tired|late|chill|relaxed|cozy)\b/.test(t)) c.tone = "low";
    if (/\b(focused|formal|work|serious|crunch)\b/.test(t)) c.tone = "high";
  }

  // Still-dormant candidate nudges (see BACKLOG):
  //   environment focus on → proactivity high (heads-down = fewer check-ins)

  // ── activity → pace (returning from a break = slow back down) ─────────────
  if (activity?.minSinceLastPrompt != null && activity.minSinceLastPrompt > 30) {
    c.pace = "low";
  }

  return c;
}

/* Compose the interpretation lens from the dials. Reads as second-person
 * "how to read my prompt", and always defers to the literal words — because
 * the cadence is inferred and fires on every prompt, so a wrong guess must
 * be cheap. */
export function buildReframe(c: Cadence): string {
  const parts: string[] = [];

  if (c.pace === "high") parts.push("keep it fast and tight — answer first, trim the preamble");
  else if (c.pace === "low") parts.push("take it slow and expansive — room to lay things out");

  if (c.posture === "high") parts.push("make the call rather than offering a menu of options");
  else if (c.posture === "low") parts.push("surface the tradeoffs and options behind what I asked");

  if (c.proactivity === "high") parts.push("act without stopping to check in");
  else if (c.proactivity === "low") parts.push("verify assumptions and lead with hypotheses before acting");

  if (c.tone === "low") parts.push("keep the tone warm and casual");
  else if (c.tone === "high") parts.push("keep the tone crisp and professional");

  const body =
    parts.length === 0
      ? "read my prompt at face value"
      : "read my prompt as someone in this cadence meant it: " + parts.join("; ");

  return body + ". If my words clearly mean otherwise, follow my words.";
}

/* ─────────────────────────────────────────────────────────────────────────
 * Manual overrides — "the mode is the user's determination, the rest is auto."
 *
 * A user can PIN any dial; pinned dials win, un-pinned dials stay inferred.
 * Two sources, checked in order (env wins over config file):
 *   1. ~/.cadence/config.json  → { "pace": "fast", "tone": "warm" }
 *   2. env vars                → CADENCE_PACE=fast CADENCE_TONE=warm
 * ───────────────────────────────────────────────────────────────────────── */
export type DialOverrides = Partial<Record<keyof Cadence, DialLevel>>;

const CONFIG_FILE = join(homedir(), ".cadence", "config.json");

function isLevel(v: unknown): v is DialLevel {
  return typeof v === "string" && (LEVELS as string[]).includes(v);
}

// Accept EITHER the internal level ("high") or the human word ("fast").
// This keeps config/env pins aligned with the CLI and the rendered board.
export function resolveDialLevel(dial: keyof Cadence, input: unknown): DialLevel | null {
  if (typeof input !== "string") return null;
  const v = input.toLowerCase();
  if (isLevel(v)) return v;
  for (const lvl of LEVELS) {
    if (DIAL_WORDS[dial][lvl].toLowerCase() === v) return lvl;
  }
  return null;
}

export async function loadOverrides(): Promise<DialOverrides> {
  const ov: DialOverrides = {};

  // config file first (lowest precedence)
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    for (const dial of DIALS) {
      const level = resolveDialLevel(dial, cfg[dial]);
      if (level) ov[dial] = level;
    }
  } catch {
    // no config file — fine
  }

  // env vars override the file
  for (const dial of DIALS) {
    const level = resolveDialLevel(dial, process.env[`CADENCE_${dial.toUpperCase()}`]);
    if (level) ov[dial] = level;
  }

  return ov;
}

/** Merge pinned dials over the inferred cadence. Returns the final board and
 * the list of dials that were user-set (so the renderer can mark them). */
export function applyOverrides(
  inferred: Cadence,
  overrides: DialOverrides
): { cadence: Cadence; pinned: (keyof Cadence)[] } {
  const cadence = { ...inferred };
  const pinned: (keyof Cadence)[] = [];
  for (const dial of DIALS) {
    const v = overrides[dial];
    if (v) {
      cadence[dial] = v;
      pinned.push(dial);
    }
  }
  return { cadence, pinned };
}
