import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { SHORT_PROMPT, LONG_PROMPT } from "./providers/activity.js";
import { detectPromptIntent } from "./providers/intent.js";
import type { NudgeFired } from "./cadence.js";
import type { Cadence, IntentSignal } from "./types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * The learning loop, half one: a per-prompt tune log.
 *
 * Opt-in (`cadence enable tuning`). The UserPromptSubmit hook appends one
 * DERIVED-FEATURES record per prompt: the dials it emitted, which nudge set
 * each one (the deriveCadenceTraced provenance), and length/intent/cue-class
 * features of the prompt itself — NEVER raw text, words, paths, or repo
 * names. Each entry's features double as follow-up evidence for the entry
 * before it: "the lens said expansive, the next words said 'be brief'" is
 * the whole signal.
 *
 * Half two: `cadence tune` pairs consecutive same-sitting entries and reports
 * per-rule agreement OFFLINE — the hook never scores, so heuristics can
 * evolve without touching the hot path. Report-only by design: it never
 * re-weights nudges; the only action it points at is the existing
 * user-authority path (pin a dial). Mirror, not nanny.
 * ───────────────────────────────────────────────────────────────────────── */

const TUNE_FILE = join(homedir(), ".cadence", "tune.json");
export const MAX_TUNE_ENTRIES = 500; // ~100KB ceiling — pruned on every write
export const PAIR_MAX_GAP_MIN = 30; // same-sitting bound, mirrors the activity break threshold

/* Cue CLASSES are the only prompt-content thing stored. Matching follows the
 * phrase-not-bare-word discipline from providers/intent.ts: a live prompt is
 * full of "do it" and "options" incidentally, so anchor or require phrases —
 * a false cue would grade a nudge on noise. */
export type FollowupCue =
  | "be-brief" // the reply ran long for the room
  | "expand" // the reply ran thin
  | "just-do-it" // stop checking in
  | "pick-one" // stop offering menus
  | "options" // wanted the menu
  | "asked-not-told"; // acted without being asked

const CUE_PATTERNS: { cue: FollowupCue; re: RegExp }[] = [
  { cue: "be-brief", re: /\b(too long|be brief|shorter|skip the preamble|tl;?dr)\b/i },
  { cue: "expand", re: /\b(more detail|walk me through|step by step|slow down)\b/i },
  {
    cue: "just-do-it",
    re: /^(just (do|fix|ship) it|go ahead|do it)\b|\b(stop asking|don'?t ask)\b/i,
  },
  { cue: "pick-one", re: /\b(just pick one|make the call|stop listing options)\b/i },
  { cue: "options", re: /\b(what are the options|alternatives?|other approaches)\b/i },
  { cue: "asked-not-told", re: /\b(i didn'?t ask|without asking|undo that)\b/i },
];

export function detectCues(prompt: string): FollowupCue[] {
  return CUE_PATTERNS.filter(({ re }) => re.test(prompt)).map(({ cue }) => cue);
}

export interface PromptFeatures {
  len: number; // chars only
  bucket: "short" | "medium" | "long"; // same thresholds as activity tempo
  intent: IntentSignal["kind"]; // the 4-way enum, or null
  gapMin?: number; // minutes since the previous prompt
  cues: FollowupCue[];
}

export function promptFeatures(prompt: string, gapMin?: number): PromptFeatures {
  const len = prompt.length;
  return {
    len,
    bucket: len < SHORT_PROMPT ? "short" : len > LONG_PROMPT ? "long" : "medium",
    intent: detectPromptIntent(prompt),
    ...(gapMin != null ? { gapMin } : {}),
    cues: detectCues(prompt),
  };
}

export interface TuneEntry {
  at: number;
  session?: string; // Claude's session_id — pairing never crosses sessions
  feat: PromptFeatures; // this prompt = follow-up evidence for the PREVIOUS entry
  emitted: Cadence; // the four final dial levels (post-override)
  pinned: (keyof Cadence)[]; // user authority — excluded from scoring
  nudges: NudgeFired[]; // provenance trace; last entry per dial = effective nudge
  injected: boolean; // false when the hook went silent (still logged for pairing)
}

export function buildTuneEntry(opts: {
  prompt: string;
  session?: string;
  emitted: Cadence;
  pinned: (keyof Cadence)[];
  nudges: NudgeFired[];
  injected: boolean;
  gapMin?: number;
  now?: number;
}): TuneEntry {
  return {
    at: opts.now ?? Date.now(),
    ...(opts.session != null ? { session: opts.session } : {}),
    feat: promptFeatures(opts.prompt, opts.gapMin),
    emitted: opts.emitted,
    pinned: opts.pinned,
    nudges: opts.nudges,
    injected: opts.injected,
  };
}

/** Newest `max` entries, order preserved. Pure — the prune-on-write bound. */
export function pruneEntries(entries: TuneEntry[], max: number): TuneEntry[] {
  return entries.length <= max ? entries : entries.slice(-max);
}

export async function readTuneLog(file = TUNE_FILE): Promise<TuneEntry[]> {
  try {
    const raw = JSON.parse(await readFile(file, "utf-8")) as unknown;
    return Array.isArray(raw) ? (raw as TuneEntry[]) : [];
  } catch {
    return []; // no/garbled log reads as empty, never throws
  }
}

export function tuneLogPath(): string {
  return TUNE_FILE;
}

export async function appendTuneEntry(entry: TuneEntry, file = TUNE_FILE): Promise<void> {
  try {
    const entries = await readTuneLog(file);
    entries.push(entry);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(pruneEntries(entries, MAX_TUNE_ENTRIES)), "utf-8");
  } catch {
    // tuning is best-effort; never let it break the hook
  }
}

/** Hook-side wrapper: the append raced against a small unref'd timer, so a
 * slow disk can never hold the prompt — same posture as the signal budget. */
export async function appendTuneEntryBounded(entry: TuneEntry, budgetMs = 250): Promise<void> {
  await Promise.race([
    appendTuneEntry(entry),
    new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref()),
  ]);
}

/* ── pairing + scoring (CLI-only, pure) ──────────────────────────────────── */

export interface TunePair {
  entry: TuneEntry;
  followup: PromptFeatures;
}

/** Entry N's follow-up evidence is entry N+1's features — but only within a
 * sitting: same session, ≤30 min apart (gap computed from the log's own
 * timestamps, so pairing never depends on activity.json's global clock). */
export function pairEntries(entries: TuneEntry[]): TunePair[] {
  const pairs: TunePair[] = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    const cur = entries[i];
    const next = entries[i + 1];
    if (!cur || !next) continue;
    if (cur.session == null || next.session !== cur.session) continue;
    const gapMin = (next.at - cur.at) / 60_000;
    if (gapMin < 0 || gapMin > PAIR_MAX_GAP_MIN) continue;
    pairs.push({ entry: cur, followup: next.feat });
  }
  return pairs;
}

export type Verdict = "agree" | "disagree" | "no-evidence";

export interface PairScore {
  verdicts: Record<keyof Cadence, Verdict>;
  // a cue pulled on a dial that sat at medium — signal existed, no rule fired,
  // so there's nothing to grade. Counted separately, never as a disagreement.
  uncaptured: (keyof Cadence)[];
}

/* Honesty note baked into the semantics: a "disagree" means the user's next
 * words pulled AGAINST the emitted lens. That can mean the read was wrong OR
 * the assistant ignored a right read — the report must never present these
 * counts as nudge-accuracy ground truth. */
export function scorePair(entry: TuneEntry, followup: PromptFeatures): PairScore {
  const verdicts: Record<keyof Cadence, Verdict> = {
    pace: "no-evidence",
    tone: "no-evidence",
    posture: "no-evidence",
    proactivity: "no-evidence",
  };
  const uncaptured: (keyof Cadence)[] = [];
  const cues = new Set(followup.cues);
  const pinned = new Set(entry.pinned);
  const e = entry.emitted;

  // Pinned dials are the user's determination, not a guess to grade.
  if (!pinned.has("pace")) {
    if (e.pace === "low") {
      if (cues.has("be-brief") || cues.has("just-do-it") || followup.intent === "ship")
        verdicts.pace = "disagree";
      else if (cues.has("expand") || followup.bucket === "long") verdicts.pace = "agree";
    } else if (e.pace === "high") {
      if (cues.has("expand")) verdicts.pace = "disagree";
      else if (
        cues.has("be-brief") ||
        (followup.gapMin != null && followup.gapMin <= 2 && followup.bucket === "short")
      )
        verdicts.pace = "agree"; // rapid short follow-up = the fast read landed
    } else if (cues.has("be-brief") || cues.has("expand")) {
      uncaptured.push("pace");
    }
  }

  if (!pinned.has("posture")) {
    if (e.posture === "low") {
      if (cues.has("pick-one") || cues.has("just-do-it")) verdicts.posture = "disagree";
      else if (cues.has("options") || followup.intent === "think") verdicts.posture = "agree";
    } else if (e.posture === "high") {
      if (cues.has("options")) verdicts.posture = "disagree";
      else if (cues.has("pick-one")) verdicts.posture = "agree";
    } else if (cues.has("pick-one") || cues.has("options")) {
      uncaptured.push("posture");
    }
  }

  if (!pinned.has("proactivity")) {
    if (e.proactivity === "high") {
      if (cues.has("asked-not-told")) verdicts.proactivity = "disagree";
    } else if (e.proactivity === "low") {
      if (cues.has("just-do-it")) verdicts.proactivity = "disagree";
    } else if (cues.has("just-do-it") || cues.has("asked-not-told")) {
      uncaptured.push("proactivity");
    }
  }

  // tone: no cue class maps to register today — always no-evidence rather
  // than a faked read. Add cues before adding verdicts here.

  return { verdicts, uncaptured };
}

/** The nudge that actually owns a dial's emitted level: last trace entry. */
export function effectiveNudge(entry: TuneEntry, dial: keyof Cadence): NudgeFired | undefined {
  for (let i = entry.nudges.length - 1; i >= 0; i--) {
    const n = entry.nudges[i];
    if (n && n.dial === dial) return n;
  }
  return undefined;
}

export interface RuleStats {
  rule: string;
  source: string;
  fired: number; // entries where this rule was the effective nudge on ≥1 dial
  agree: number;
  disagree: number;
}

export interface TuneAggregate {
  logged: number;
  pairs: number;
  withEvidence: number; // pairs carrying ≥1 agree/disagree verdict
  uncaptured: number;
  stats: RuleStats[]; // sorted most-contested first
}

export function aggregateByRule(entries: TuneEntry[]): TuneAggregate {
  const byRule = new Map<string, RuleStats>();
  const stat = (rule: string, source: string): RuleStats => {
    let s = byRule.get(rule);
    if (!s) {
      s = { rule, source, fired: 0, agree: 0, disagree: 0 };
      byRule.set(rule, s);
    }
    return s;
  };

  const DIALS: (keyof Cadence)[] = ["pace", "tone", "posture", "proactivity"];

  // fired: once per entry per rule, counted over the WHOLE log (not just
  // pairs) so the report shows how often a rule speaks vs. how often it's
  // contested. Entries from renamed rules still aggregate — by their old id.
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const dial of DIALS) {
      const n = effectiveNudge(entry, dial);
      if (n && !seen.has(n.rule)) {
        seen.add(n.rule);
        stat(n.rule, n.source).fired++;
      }
    }
  }

  const pairs = pairEntries(entries);
  let withEvidence = 0;
  let uncaptured = 0;
  for (const { entry, followup } of pairs) {
    const score = scorePair(entry, followup);
    uncaptured += score.uncaptured.length;
    let evidenced = false;
    for (const dial of DIALS) {
      const v = score.verdicts[dial];
      if (v === "no-evidence") continue;
      evidenced = true;
      const n = effectiveNudge(entry, dial);
      if (!n) continue; // off-medium with no nudge can only mean pinned; already excluded
      const s = stat(n.rule, n.source);
      if (v === "agree") s.agree++;
      else s.disagree++;
    }
    if (evidenced) withEvidence++;
  }

  const stats = [...byRule.values()].sort(
    (a, b) => b.disagree - a.disagree || b.fired - a.fired || a.rule.localeCompare(b.rule)
  );

  return { logged: entries.length, pairs: pairs.length, withEvidence, uncaptured, stats };
}

/** The `cadence tune` report. Pure string so the CLI stays a thin shell. */
export function renderTuneReport(entries: TuneEntry[]): string {
  const agg = aggregateByRule(entries);
  const lines: string[] = [];
  lines.push("  cadence tune — the lens vs. your next words");
  lines.push("");
  lines.push(
    `  ${agg.logged} prompts logged · ${agg.pairs} same-sitting pairs · ${agg.withEvidence} with evidence`
  );
  lines.push("");

  if (agg.stats.length === 0) {
    lines.push("  no nudges have fired yet — the table fills as signals move dials.");
  } else {
    lines.push(
      `  ${"rule".padEnd(22)}${"source".padEnd(14)}${"fired".padStart(5)}${"agree".padStart(7)}${"disagree".padStart(10)}`
    );
    for (const r of agg.stats) {
      lines.push(
        `  ${r.rule.padEnd(22)}${r.source.padEnd(14)}${String(r.fired).padStart(5)}${String(
          r.agree
        ).padStart(7)}${String(r.disagree).padStart(10)}`
      );
    }
    const top = agg.stats[0];
    if (top && top.disagree > 0) {
      lines.push("");
      lines.push(`  most contested: ${top.rule} (${top.disagree} disagree / ${top.agree} agree)`);
    }
  }

  if (agg.uncaptured > 0) {
    lines.push(
      `  uncaptured pulls: ${agg.uncaptured} (a cue fired while the dial sat at medium — no rule to grade)`
    );
  }

  lines.push("");
  lines.push("  tension between the lens and your next words can mean the read was wrong");
  lines.push("  OR the assistant ignored a right read — treat counts as smoke, not verdicts.");
  lines.push("  if a dial keeps fighting you, pin it: cadence set <dial> <level>");
  return lines.join("\n");
}
