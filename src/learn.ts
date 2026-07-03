import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { SHORT_PROMPT, LONG_PROMPT } from "./providers/activity.js";
import { detectPromptIntent } from "./providers/intent.js";
import type { NudgeFired } from "./cadence.js";
import type { Cadence, DialLevel, IntentSignal } from "./types.js";

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
  | "asked-not-told" // acted without being asked
  | "too-casual" // the register ran chummy for the room
  | "too-formal"; // the register ran stiff for the room

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
  // register cues — the only follow-up evidence the tone dial gets. Phrase
  // discipline matters double here: "professional" and "casual" are everywhere
  // in prompts about OTHER things, so only anchored complaints count.
  {
    cue: "too-casual",
    re: /\b(too casual|too chatty|keep it professional|be more professional|drop the banter|less banter)\b/i,
  },
  { cue: "too-formal", re: /\b(too formal|too stiff|lighten up|loosen up|drop the formality)\b/i },
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

  // tone: graded only on the two anchored register-complaint cues — anything
  // subtler stays no-evidence rather than a faked read.
  if (!pinned.has("tone")) {
    if (e.tone === "low") {
      if (cues.has("too-casual")) verdicts.tone = "disagree";
      else if (cues.has("too-formal")) verdicts.tone = "agree"; // they wanted warmer than even "warm" — the direction held
    } else if (e.tone === "high") {
      if (cues.has("too-formal")) verdicts.tone = "disagree";
      else if (cues.has("too-casual")) verdicts.tone = "agree";
    } else if (cues.has("too-casual") || cues.has("too-formal")) {
      uncaptured.push("tone");
    }
  }

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

/* ── per-rule pushback vs baseline (CLI-only, pure) ──────────────────────────
 *
 * The report half of the learning loop. Everything here is a pure function
 * over an injected entry array, so tests hand it synthetic logs. Advisory by
 * design: it ends in suggestions that point at the two existing authority
 * paths (pin a dial / retune deriveCadence by hand) and NEVER edits mappings,
 * config, or the log itself.
 * ───────────────────────────────────────────────────────────────────────── */

/* The rule ids deriveCadenceTraced() can emit today. A rule in the log but
 * not here was renamed/removed — the report groups those "orphans" by source
 * instead of pretending they're tunable. Kept as a mirror (not an import of
 * live behavior) so reading an old log never depends on current signals; a
 * test probes deriveCadenceTraced to keep this list honest. */
export const CURRENT_RULE_IDS: ReadonlySet<string> = new Set([
  "env.late",
  "env.early-morning",
  "env.weekend",
  "env.gloomy",
  "env.battery",
  "env.busy",
  "music.energy-high",
  "music.energy-low",
  "music.intense",
  "music.ambient",
  "music.warm",
  "git.streak",
  "git.conflict",
  "calendar.imminent",
  "intent.ship",
  "intent.think",
  "intent.debug",
  "intent.review",
  "intent.focus",
  "report.ship",
  "report.think",
  "report.debug",
  "report.chill",
  "report.formal",
  "activity.rapid",
  "activity.considered",
  "activity.break",
]);

/** Below this many evaluated pairs a rule is never flagged — a 2/4 "50% rate"
 * is noise, not signal. Stated in the report so the bar is legible. */
export const MIN_SAMPLE = 10;
/** A rule must draw pushback at least this often — AND at ≥2× its baseline —
 * before the report suggests softening it. */
export const FLAG_MIN_RATE = 0.2;

export interface RulePushback {
  rule: string;
  source: string;
  fired: number; // whole-log entries where this rule was the effective nudge on ≥1 dial
  observed: number; // of those, same-sitting pairs (a follow-up existed to grade against)
  pushback: number; // observed pairs where a dial THIS rule owned drew a disagree
  rate: number | null; // pushback / observed
  baseline: number | null; // any-pushback rate across pairs where this rule did NOT fire
  flagged: boolean;
  read: string; // the plain-language line
  suggestion?: string; // only when flagged — always advisory
}

export interface SourceOrphans {
  source: string;
  rules: string[];
  fired: number;
  observed: number;
  pushback: number;
}

export interface PushbackReport {
  logged: number;
  pairs: number;
  overallPushback: number | null; // any-disagree rate across all pairs
  minSample: number;
  rules: RulePushback[]; // current rules, most concerning first
  orphans: SourceOrphans[]; // renamed/removed rule ids, grouped by source
}

const ALL_DIALS: (keyof Cadence)[] = ["pace", "tone", "posture", "proactivity"];

// Pushback against "low" pulled the user toward "high" and vice versa — the
// suggested pin points where their own follow-ups pointed.
const PULLED_TOWARD: Record<DialLevel, DialLevel> = { low: "high", medium: "medium", high: "low" };

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function analyzePushback(
  entries: TuneEntry[],
  currentRules: ReadonlySet<string> = CURRENT_RULE_IDS
): PushbackReport {
  interface Acc {
    rule: string;
    source: string;
    fired: number;
    observed: number;
    pushback: number;
    anyDisagree: number; // observed pairs where ANY rule drew a disagree (for the baseline complement)
    contested: Map<keyof Cadence, { level: DialLevel; disagree: number }>;
  }
  const byRule = new Map<string, Acc>();
  const acc = (rule: string, source: string): Acc => {
    let a = byRule.get(rule);
    if (!a) {
      a = { rule, source, fired: 0, observed: 0, pushback: 0, anyDisagree: 0, contested: new Map() };
      byRule.set(rule, a);
    }
    return a;
  };

  // fired: whole-log, once per entry per rule — same semantics as aggregateByRule.
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const dial of ALL_DIALS) {
      const n = effectiveNudge(entry, dial);
      if (n && !seen.has(n.rule)) {
        seen.add(n.rule);
        acc(n.rule, n.source).fired++;
      }
    }
  }

  const pairs = pairEntries(entries);
  let disagreePairs = 0;
  for (const { entry, followup } of pairs) {
    const score = scorePair(entry, followup);
    const pairHasDisagree = ALL_DIALS.some((d) => score.verdicts[d] === "disagree");
    if (pairHasDisagree) disagreePairs++;

    // Which rules were effective this entry, and whether a dial each OWNED
    // drew the disagree (a rule isn't dinged for another rule's dial).
    const perRule = new Map<string, { a: Acc; owned: boolean }>();
    for (const dial of ALL_DIALS) {
      const n = effectiveNudge(entry, dial);
      if (!n) continue;
      const a = acc(n.rule, n.source);
      let r = perRule.get(n.rule);
      if (!r) {
        r = { a, owned: false };
        perRule.set(n.rule, r);
      }
      if (score.verdicts[dial] === "disagree") {
        r.owned = true;
        const c = a.contested.get(dial) ?? { level: n.level, disagree: 0 };
        c.disagree++;
        c.level = n.level;
        a.contested.set(dial, c);
      }
    }
    for (const { a, owned } of perRule.values()) {
      a.observed++;
      if (owned) a.pushback++;
      if (pairHasDisagree) a.anyDisagree++;
    }
  }

  const total = pairs.length;
  const rules: RulePushback[] = [];
  const orphanMap = new Map<string, SourceOrphans>();
  for (const a of byRule.values()) {
    if (!currentRules.has(a.rule)) {
      const o = orphanMap.get(a.source) ?? {
        source: a.source,
        rules: [],
        fired: 0,
        observed: 0,
        pushback: 0,
      };
      o.rules.push(a.rule);
      o.fired += a.fired;
      o.observed += a.observed;
      o.pushback += a.pushback;
      orphanMap.set(a.source, o);
      continue;
    }

    const rate = a.observed > 0 ? a.pushback / a.observed : null;
    // Baseline = pushback rate when this rule sat out. A globally grumpy week
    // raises the baseline right along with the rule's own rate, so the week
    // doesn't indict the rule.
    const rest = total - a.observed;
    const baseline = rest > 0 ? (disagreePairs - a.anyDisagree) / rest : null;

    let flagged = false;
    let read: string;
    let suggestion: string | undefined;
    if (a.observed < MIN_SAMPLE) {
      read = `fired ${a.fired}×, ${a.observed} evaluated pair${a.observed === 1 ? "" : "s"} — not enough data yet (flags need n≥${MIN_SAMPLE})`;
    } else {
      const r = rate ?? 0;
      const vs =
        baseline != null
          ? `${pct(r)} vs ${pct(baseline)} baseline`
          : `${pct(r)}, no baseline — it fired in every evaluated pair`;
      const head = `fired ${a.fired}×, pushback followed ${a.pushback}× of ${a.observed} evaluated (${vs})`;
      flagged = a.pushback > 0 && r >= FLAG_MIN_RATE && (baseline == null || r >= 2 * baseline);
      if (flagged) {
        read = `${head} — consider softening`;
        let top: { dial: keyof Cadence; level: DialLevel; disagree: number } | undefined;
        for (const [dial, c] of a.contested) {
          if (!top || c.disagree > top.disagree) top = { dial, ...c };
        }
        suggestion = top
          ? `consider \`cadence set ${top.dial} ${PULLED_TOWARD[top.level]}\` to overrule it, or retune the mapping in deriveCadence() (src/cadence.ts, search "${a.rule}")`
          : `retune the mapping in deriveCadence() (src/cadence.ts, search "${a.rule}")`;
      } else if (a.pushback === 0) {
        read = `${head} — holding up`;
      } else if (baseline != null && r > baseline) {
        read = `${head} — above baseline, worth watching`;
      } else {
        read = `${head} — within baseline`;
      }
    }

    rules.push({
      rule: a.rule,
      source: a.source,
      fired: a.fired,
      observed: a.observed,
      pushback: a.pushback,
      rate,
      baseline,
      flagged,
      read,
      ...(suggestion != null ? { suggestion } : {}),
    });
  }

  rules.sort(
    (x, y) =>
      Number(y.flagged) - Number(x.flagged) ||
      (y.rate ?? -1) - (x.rate ?? -1) ||
      y.fired - x.fired ||
      x.rule.localeCompare(y.rule)
  );
  const orphans = [...orphanMap.values()].sort((x, y) => x.source.localeCompare(y.source));

  return {
    logged: entries.length,
    pairs: total,
    overallPushback: total > 0 ? disagreePairs / total : null,
    minSample: MIN_SAMPLE,
    rules,
    orphans,
  };
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

  // ── per-rule pushback vs baseline ──────────────────────────────────────────
  const pb = analyzePushback(entries);
  if (pb.rules.length > 0) {
    lines.push("");
    lines.push("  per-rule pushback (rate = pairs where the rule's own dial drew a disagree;");
    lines.push("  baseline = any-pushback rate in pairs where the rule did NOT fire — a grumpy");
    lines.push(`  week raises both, so it indicts neither. flags need n≥${pb.minSample} evaluated pairs):`);
    for (const r of pb.rules) {
      lines.push(`    ${r.rule}: ${r.read}`);
    }
    if (pb.overallPushback != null) {
      lines.push(`    (overall: pushback in ${pct(pb.overallPushback)} of ${pb.pairs} evaluated pairs)`);
    }
  }

  if (pb.orphans.length > 0) {
    lines.push("");
    lines.push("  orphaned rule ids (renamed/removed from the current rule set), by source:");
    for (const o of pb.orphans) {
      lines.push(
        `    ${o.source}: ${o.rules.length} rule${o.rules.length === 1 ? "" : "s"} (${o.rules.join(", ")}) · fired ${o.fired}× · pushback ${o.pushback}/${o.observed} evaluated`
      );
    }
  }

  const flagged = pb.rules.filter((r) => r.flagged);
  if (flagged.length > 0) {
    lines.push("");
    lines.push("  suggested actions (advisory only — cadence never edits mappings or pins for you):");
    for (const r of flagged) {
      lines.push(`    ${r.rule}: ${r.suggestion ?? ""}`);
    }
  } else if (pb.pairs > 0) {
    lines.push("");
    lines.push(
      `  no rule crosses the flag bar (n≥${pb.minSample} evaluated pairs, ≥${pct(FLAG_MIN_RATE)} pushback, ≥2× baseline) — nothing to suggest yet.`
    );
  }

  lines.push("");
  lines.push("  tension between the lens and your next words can mean the read was wrong");
  lines.push("  OR the assistant ignored a right read — treat counts as smoke, not verdicts.");
  lines.push("  if a dial keeps fighting you, pin it: cadence set <dial> <level>");
  return lines.join("\n");
}
