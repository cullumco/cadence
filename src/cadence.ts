import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
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
    // env.focus (enabled 2026-07-03, formerly the last dormant nudge): a
    // hand-flipped Focus is a gesture, not atmosphere — heads-down means fewer
    // check-ins. MANUAL only (focusManual); a scheduled window is calendar-
    // shaped routine and stays flavor. Still the weakest tier: git conflict,
    // intent.debug, and any self-report all override — and inferred
    // proactivity=high never grants Stop-hook authority (that takes a pin or
    // a ship self-report; see stop.ts). Guard: environment is a bundle of
    // independent facts, but it must never complete the whole board in one
    // pass — if its other sub-rules already moved three dials, focus stays
    // quiet ("no single signal moves all four", CLAUDE.md).
    if (environment.focusManual) {
      const envDials = new Set(
        nudges.filter((n) => n.source === "environment").map((n) => n.dial)
      );
      if (envDials.size < 3) {
        nudge("proactivity", "high", "environment", "env.focus");
      }
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
 * Three sources, weakest → strongest (each layer overrides the one before it
 * per dial):
 *   1. global pins   ~/.cadence/config.json → { "pace": "fast" }
 *   2. project pins  ~/.cadence/config.json → { "projects": {
 *                      "/abs/dir": { "proactivity": "low" } } }
 *      matched by walking UP from the hook's cwd, deepest directory wins
 *   3. env vars      CADENCE_PACE=fast CADENCE_TONE=warm
 * ───────────────────────────────────────────────────────────────────────── */
export type DialOverrides = Partial<Record<keyof Cadence, DialLevel>>;

/** Where a pinned dial came from — kept so the CLI can tell the user which
 * authority set it (the injected block keeps the plain `*`). */
export type PinSource = "global" | "project" | "env";

export interface ResolvedOverrides {
  overrides: DialOverrides;
  sources: Partial<Record<keyof Cadence, PinSource>>;
}

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

/* Per-project pins live ONLY in the user's ~/.cadence/config.json (the
 * `projects` map, keyed by absolute directory path). We deliberately do NOT
 * read pins from any file committed inside a repo: a repo-committed pin file
 * would let whoever ships the repo pin proactivity=high on everyone who
 * clones it — dial authority must stay with the user, in the user's own
 * config. Don't "fix" this by adding a .cadence file loader.
 *
 * Pure resolution: given the raw `projects` value and a cwd, walk up the
 * directory tree — a pin on a repo root applies in its subdirectories, and
 * on a conflict the DEEPEST matching directory wins per dial. Garbled
 * entries (non-objects, bad levels) read as "no pin," never throw. */
export function resolveProjectPins(projectsRaw: unknown, cwd: string): DialOverrides {
  if (!projectsRaw || typeof projectsRaw !== "object" || Array.isArray(projectsRaw) || !cwd)
    return {};
  const target = resolve(cwd);
  const matches: { depth: number; pins: Record<string, unknown> }[] = [];
  for (const [key, pins] of Object.entries(projectsRaw as Record<string, unknown>)) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) continue;
    const dir = resolve(key);
    // boundary-safe prefix match: "/a/b" matches "/a/b/c" but never "/a/bc"
    if (target === dir || target.startsWith(dir.endsWith(sep) ? dir : dir + sep)) {
      matches.push({ depth: dir.split(sep).length, pins: pins as Record<string, unknown> });
    }
  }
  // shallowest first, so deeper directories override per dial (deepest wins)
  matches.sort((a, b) => a.depth - b.depth);
  const ov: DialOverrides = {};
  for (const m of matches) {
    for (const dial of DIALS) {
      const level = resolveDialLevel(dial, m.pins[dial]);
      if (level) ov[dial] = level;
    }
  }
  return ov;
}

/** Pure precedence merge, weakest → strongest: global → project → env.
 * Tracks which layer won each dial so the CLI can label it. */
export function mergeOverrideLayers(
  global: DialOverrides,
  project: DialOverrides,
  env: DialOverrides
): ResolvedOverrides {
  const overrides: DialOverrides = {};
  const sources: Partial<Record<keyof Cadence, PinSource>> = {};
  const layers: [DialOverrides, PinSource][] = [
    [global, "global"],
    [project, "project"],
    [env, "env"],
  ];
  for (const [layer, source] of layers) {
    for (const dial of DIALS) {
      const v = layer[dial];
      if (v) {
        overrides[dial] = v;
        sources[dial] = source;
      }
    }
  }
  return { overrides, sources };
}

/** Load pins with provenance. `cwd` scopes project pins (walk-up match);
 * omit it and only global + env pins apply. */
export async function loadOverridesDetailed(cwd?: string): Promise<ResolvedOverrides> {
  const global: DialOverrides = {};
  let project: DialOverrides = {};

  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    for (const dial of DIALS) {
      const level = resolveDialLevel(dial, cfg[dial]);
      if (level) global[dial] = level;
    }
    if (cwd) project = resolveProjectPins(cfg["projects"], cwd);
  } catch {
    // no config file — fine
  }

  // env vars beat everything
  const env: DialOverrides = {};
  for (const dial of DIALS) {
    const level = resolveDialLevel(dial, process.env[`CADENCE_${dial.toUpperCase()}`]);
    if (level) env[dial] = level;
  }

  return mergeOverrideLayers(global, project, env);
}

export async function loadOverrides(cwd?: string): Promise<DialOverrides> {
  return (await loadOverridesDetailed(cwd)).overrides;
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
