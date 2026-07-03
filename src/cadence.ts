import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  UserState,
  Cadence,
  DialLevel,
  Signal,
  MusicSignal,
  SelfReportSignal,
  GitSignal,
  ActivitySignal,
  IntentSignal,
  EnvironmentSignal,
  CalendarSignal,
} from "./types.js";

export const DIALS = ["pace", "tone", "posture", "proactivity"] as const;
const LEVELS: DialLevel[] = ["low", "medium", "high"];

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
 *   intent   { kind }                  ← read from the prompt you just typed
 *   music    { vibe, energy }          ← energy 0–1 drives pace; vibe colors tone
 *   git      { commitsLastHour, ... }  ← work rhythm
 *   calendar { minutesToNextEvent }    ← opt-in ICS feed; wrap-up pressure
 *   activity { minSinceLastPrompt, promptLength, tempo }
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

/* One dial movement with its provenance — which rule, fed by which signal,
 * set which dial. The opt-in tune log stores these so `cadence tune` can
 * attribute next-prompt pushback to the exact nudge that fired. Rule ids are
 * part of the log format: keep them stable across retunes where possible
 * (renamed ids orphan historical entries; the report degrades to source). */
export interface NudgeFired {
  dial: keyof Cadence;
  level: DialLevel;
  source: Signal["source"];
  rule: string;
}

export function deriveCadence(state: UserState): Cadence {
  return deriveCadenceTraced(state).cadence;
}

export function deriveCadenceTraced(state: UserState): {
  cadence: Cadence;
  nudges: NudgeFired[];
} {
  const music = state.signals.find((s): s is MusicSignal => s.source === "music");
  const report = state.signals.find(
    (s): s is SelfReportSignal => s.source === "self_report"
  );
  const git = state.signals.find((s): s is GitSignal => s.source === "git");
  const intent = state.signals.find(
    (s): s is IntentSignal => s.source === "intent"
  );
  const activity = state.signals.find(
    (s): s is ActivitySignal => s.source === "activity"
  );
  const environment = state.signals.find(
    (s): s is EnvironmentSignal => s.source === "environment"
  );
  const calendar = state.signals.find(
    (s): s is CalendarSignal => s.source === "calendar"
  );

  // Start neutral; each signal nudges individual dials.
  const c: Cadence = {
    pace: "medium",
    tone: "medium",
    posture: "medium",
    proactivity: "medium",
  };

  // Sets the dial AND records provenance. Application order below is
  // unchanged, so the EFFECTIVE nudge for a dial is simply the last trace
  // entry for that dial — last-write-wins stays the collision rule.
  const nudges: NudgeFired[] = [];
  const nudge = (
    dial: keyof Cadence,
    level: DialLevel,
    source: Signal["source"],
    rule: string
  ) => {
    c[dial] = level;
    nudges.push({ dial, level, source, rule });
  };

  // ── environment → soft nudges FIRST (weakest), so stronger signals below win ──
  // Atmosphere, not orders: it colors the default, then music/self-report/git
  // can override. "It's late" shouldn't beat "I'm shipping."
  if (environment) {
    if (environment.hour >= 22 || environment.hour < 6)
      nudge("pace", "low", "environment", "env.late"); // late → gentler
    if (environment.partOfDay === "early morning")
      nudge("pace", "low", "environment", "env.early-morning"); // easing in
    if (environment.isWeekend) nudge("tone", "low", "environment", "env.weekend"); // looser on weekends
    if (environment.weather && /rain|snow|fog|storm|cloud/.test(environment.weather)) {
      nudge("tone", "low", "environment", "env.gloomy"); // gloomy out → warmer in
    }
    if (environment.onBattery) nudge("pace", "high", "environment", "env.battery"); // mobile/untethered → quick hits
    if (environment.loadHigh) {
      nudge("pace", "high", "environment", "env.busy"); // something's running → get an answer, get back to it
      nudge("posture", "high", "environment", "env.busy"); // decisive while waiting — don't want a survey
    }
  }

  // ── music → pace + posture + tone (move WITH the music) ───────────────────
  // Deliberately moves three dials, not one: a track has a tempo (pace), an
  // intensity (decisive vs. spacious posture), and a texture (warm tone). It
  // leaves PROACTIVITY alone — whether to act without checking in is the user's
  // call (self-report/intent/git), never the soundtrack's. See CLAUDE.md.
  if (music?.energy != null) {
    if (music.energy >= 0.7) nudge("pace", "high", "music", "music.energy-high"); // driving → fast
    else if (music.energy <= 0.4) nudge("pace", "low", "music", "music.energy-low"); // mellow → deliberate
    if (music.energy >= 0.75) nudge("posture", "high", "music", "music.intense"); // high intensity → decisive momentum
    else if (music.energy <= 0.35) nudge("posture", "low", "music", "music.ambient"); // ambient → spacious, exploratory
  }
  // organic/acoustic texture, or mellow vibe words, warm the tone
  if (
    (music?.acoustic != null && music.acoustic >= 0.5) ||
    (music?.vibe && /\b(calm|chilled|ethereal|romantic|warm|sexy)\b/.test(music.vibe))
  ) {
    nudge("tone", "low", "music", "music.warm");
  }

  // ── calendar → pace + posture (wrap-up pressure, opt-in) ──────────────────
  // An event starting in ≤15 minutes is the hardest wall-clock fact in the
  // room: wrap up, give me the call. Deliberately TWO dials only — never tone
  // (a meeting isn't a mood) and never proactivity (acting without checking in
  // stays the user's explicit call via self-report/intent/git, the same
  // boundary music keeps). Sits above music — a deadline beats a soundtrack —
  // but below git/intent/self-report: what you're doing and what you just
  // said still outrank the clock.
  if (calendar && calendar.minutesToNextEvent <= 15) {
    nudge("pace", "high", "calendar", "calendar.imminent");
    nudge("posture", "high", "calendar", "calendar.imminent");
  }

  // ── git → pace / proactivity (what you're DOING, not what you said) ───────
  // Enabled 2026-06-05 after the flavor proved trustworthy in real use.
  // Applied below self-report on purpose: "I'm shipping" beats a mid-conflict
  // read — the user's explicit word stays the higher authority.
  if (git) {
    if (git.commitsLastHour >= 3) {
      nudge("pace", "high", "git", "git.streak"); // flow state
      nudge("proactivity", "high", "git", "git.streak"); // in the groove → act, don't ask
    }
    if (git.conflicted) nudge("proactivity", "low", "git", "git.conflict"); // verify, don't barrel
  }

  // ── prompt intent → posture / proactivity / tone (what you JUST typed) ────
  // Read from the live prompt, so the "same prompt, different room" behavior
  // fires without a separate CLI step. Stronger than git (what you're doing),
  // weaker than self-report below (a deliberate, out-of-band declaration), so
  // an explicit `cadence report "thinking"` still beats a stray "ship it".
  if (intent?.kind) {
    if (intent.kind === "ship") {
      nudge("posture", "high", "intent", "intent.ship");
      nudge("proactivity", "high", "intent", "intent.ship");
      nudge("pace", "high", "intent", "intent.ship");
    } else if (intent.kind === "think") {
      nudge("posture", "low", "intent", "intent.think");
      nudge("pace", "low", "intent", "intent.think");
    } else if (intent.kind === "debug") {
      nudge("posture", "low", "intent", "intent.debug");
      nudge("proactivity", "low", "intent", "intent.debug");
    } else if (intent.kind === "review") {
      nudge("pace", "low", "intent", "intent.review");
      nudge("posture", "low", "intent", "intent.review"); // surface issues, not just pick one
      nudge("proactivity", "low", "intent", "intent.review"); // flag, don't apply
    } else if (intent.kind === "focus") {
      nudge("tone", "high", "intent", "intent.focus");
    }
  }

  // ── self-report → posture / proactivity / tone (you know your state) ──────
  if (report) {
    const t = report.text.toLowerCase();
    if (/\b(ship|shipping|jamming|locked.?in|sending|grind|just|send it)\b/.test(t)) {
      nudge("posture", "high", "self_report", "report.ship");
      nudge("proactivity", "high", "self_report", "report.ship");
      nudge("pace", "high", "self_report", "report.ship");
    }
    if (/\b(think|thinking|exploring|planning|deciding|tradeoff|figuring|weigh)\b/.test(t)) {
      nudge("posture", "low", "self_report", "report.think");
      nudge("pace", "low", "self_report", "report.think");
    }
    if (/\b(stuck|broken|confused|debug|wtf|borked|why)\b/.test(t)) {
      nudge("posture", "low", "self_report", "report.debug"); // lead with hypotheses, don't take framing at face value
      nudge("proactivity", "low", "self_report", "report.debug"); // verify before acting
    }
    if (/\b(beers?|tired|late|chill|relaxed|cozy)\b/.test(t)) nudge("tone", "low", "self_report", "report.chill");
    if (/\b(focused|formal|work|serious|crunch)\b/.test(t)) nudge("tone", "high", "self_report", "report.formal");
  }

  // Still-dormant candidate nudges (see BACKLOG):
  //   environment focus on → proactivity high (heads-down = fewer check-ins)

  // ── activity → pace (motor tempo + return-from-break) ─────────────────────
  // typing tempo (opt-in): rapid-fire short prompts read as fast; one long
  // considered prompt reads as deliberate. Only set when the user opted in.
  if (activity?.tempo === "rapid") nudge("pace", "high", "activity", "activity.rapid");
  else if (activity?.tempo === "considered") nudge("pace", "low", "activity", "activity.considered");
  // a long gap since the last prompt = returning from a break = slow back down.
  if (activity?.minSinceLastPrompt != null && activity.minSinceLastPrompt > 30) {
    nudge("pace", "low", "activity", "activity.break");
  }

  return { cadence: c, nudges };
}

/* Compose the interpretation lens from the dials. Reads as second-person
 * "how to read my prompt" AND licenses answering in the room's register
 * ("answer in kind") — a warm slow room should get a warm unhurried reply,
 * not default assistant prose. Still always defers to the literal words —
 * the cadence is inferred and fires on every prompt, so a wrong guess must
 * be cheap. */
export function buildReframe(c: Cadence): string {
  const parts: string[] = [];

  if (c.pace === "high") parts.push("keep it fast and tight — answer first, trim the preamble");
  else if (c.pace === "low")
    parts.push("take it slow and expansive — room to lay things out, let the answer breathe");

  if (c.posture === "high") parts.push("make the call rather than offering a menu of options");
  else if (c.posture === "low") parts.push("surface the tradeoffs and options behind what I asked");

  if (c.proactivity === "high") parts.push("act without stopping to check in");
  else if (c.proactivity === "low") parts.push("verify assumptions and lead with hypotheses before acting");

  if (c.tone === "low")
    parts.push("keep the tone warm and casual — drop the formality and write like a sharp friend, not a memo");
  else if (c.tone === "high")
    parts.push("keep the tone crisp and professional — tight, structured, no banter");

  const body =
    parts.length === 0
      ? "read my prompt at face value"
      : "read my prompt as someone in this cadence meant it, and answer in kind: " + parts.join("; ");

  return body + ". If my words clearly mean otherwise — in what I ask or how I sound — follow my words.";
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
