import type { IntentSignal } from "../types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Prompt intent — read the cadence out of the words the user JUST typed.
 *
 * Self-report (`cadence report "…"`) is deliberate and out-of-band; it stays
 * the higher authority. But most users never run it, so the marquee
 * "same prompt, different room" only ever fired from a separate CLI step.
 * This closes that gap: the live prompt itself is a signal.
 *
 * Deliberately CONSERVATIVE. The self-report regex can lean on bare words
 * ("just", "why") because that text is a considered status line. A live
 * prompt is full of those words incidentally ("can you just check…", "why is
 * this slow?"), so here we match PHRASES and verb framings, not lone tokens —
 * a false ship-read would wrongly flip Claude to act-freely. The reframe still
 * defers to the literal words, so a miss stays cheap, but we keep misses rare.
 * ───────────────────────────────────────────────────────────────────────── */

export type IntentKind = NonNullable<IntentSignal["kind"]>;

// Ordered weakest-cue → strongest is not needed; each kind is independent and
// the first match wins. Order them by how decisive the framing is.
const PATTERNS: { kind: IntentKind; re: RegExp }[] = [
  {
    kind: "debug",
    re: /\b(debug(ging)?|stack ?trace|tracebacks?|why (is|are|does|do|won'?t|isn'?t|can'?t)|stuck on|can'?t figure|keeps? (failing|crashing|breaking)|throwing|segfault|regression)\b/i,
  },
  {
    kind: "think",
    re: /\b(thinking through|let'?s think|think about|weigh(ing)? (the|our|up)|trade-?offs?|brainstorm|explore (the )?options|pros and cons|not sure (which|whether|if)|help me decide|which approach|architect(ure|ing)?\b.*\b(should|best)|design (the|a) )\b/i,
  },
  {
    kind: "ship",
    re: /\b(ship it|let'?s ship|ready to ship|send it|just send|locked in|lock(ing)? in|crank(ing)? (out|through)|grind(ing)? (out|through)|knock (this|these|it) out|let'?s go\b|let'?s finish|wrap (this|it) up|push it through|get (this|it) done|close (this|it) out|let'?s just (do|finish|ship|push))\b/i,
  },
  {
    kind: "focus",
    re: /\b(deep work|heads ?down|focus mode|in the zone|no distractions|need to concentrate)\b/i,
  },
];

/** Detect a single dominant intent kind from a prompt, or null when the
 * wording carries no clear cadence cue. Pure + exported for fixture tests. */
export function detectPromptIntent(prompt: string): IntentKind | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(prompt)) return kind;
  }
  return null;
}

export async function getIntentSignal(
  prompt: string | undefined
): Promise<IntentSignal | null> {
  if (!prompt) return null;
  const kind = detectPromptIntent(prompt);
  if (!kind) return null; // no cue → no signal (silent, never a guess)
  return { source: "intent", kind };
}
