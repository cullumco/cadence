/* ─────────────────────────────────────────────────────────────────────────
 * `cadence demo` core — "same prompt, different room," generated honestly.
 *
 * The demo's credibility rests on ONE rule: nothing in here is a mock of the
 * pipeline. Scenes are synthetic SIGNALS (the inputs), but everything after
 * them — intent detection on the demo prompt, deriveCadenceTraced, the
 * reframe, the rendered block — is the exact code the live hook runs. Anyone
 * skeptical can read this file and re-run the demo themselves.
 *
 * The two canonical rooms below are the product's opening argument (they land
 * in the README). Tuning them is tuning the pitch — same spirit as
 * deriveCadence() being "THE file": the scene table is meant to be evolved,
 * but keep each room a COHERENT story a developer recognizes, not a dial
 * showcase.
 * ───────────────────────────────────────────────────────────────────────── */
import type { Signal, UserState, StateWithCadence, Cadence } from "./types.js";
import {
  deriveCadenceTraced,
  buildReframe,
  DIALS,
  DIAL_WORDS,
  type NudgeFired,
} from "./cadence.js";
import { render } from "./inject.js";
import { detectPromptIntent } from "./providers/intent.js";

export interface DemoScene {
  id: string;
  label: string; // section heading, e.g. "Friday night, shipping"
  blurb: string; // one narrative line under the heading
  signals: (now: number) => Signal[];
}

/* The canonical rooms. Each one tells a story where every signal pulls the
 * same direction a real session would — the contrast between them is the
 * demo. Signal order here is render order in the block (context first, then
 * what's playing, what you said, what you're doing). */
export const DEMO_SCENES: Record<string, DemoScene> = {
  ship: {
    id: "ship",
    label: "Friday night, shipping",
    blurb:
      "11pm, four commits in the last hour, Overmono up loud, self-report says shipping.",
    signals: (now) => [
      {
        source: "environment",
        partOfDay: "late night",
        dayOfWeek: "friday",
        isWeekend: false,
        hour: 23,
        darkMode: true,
      },
      {
        source: "music",
        track: "So U Kno",
        artist: "Overmono",
        player: "Spotify",
        vibe: "energetic, driving",
        energy: 0.8,
        acoustic: 0.1,
      },
      { source: "self_report", text: "shipping — send it", setAt: now },
      {
        source: "git",
        commitsLastHour: 4,
        minSinceLastCommit: 9,
        filesDirty: 2,
        conflicted: false,
      },
    ],
  },
  think: {
    id: "think",
    label: "Tuesday morning, thinking it through",
    blurb:
      "10am, mid-rebase with conflicts, Boards of Canada on low, self-report says thinking.",
    signals: (now) => [
      {
        source: "environment",
        partOfDay: "morning",
        dayOfWeek: "tuesday",
        isWeekend: false,
        hour: 10,
      },
      {
        source: "music",
        track: "Dayvan Cowboy",
        artist: "Boards of Canada",
        player: "Music",
        vibe: "calm, ethereal",
        energy: 0.3,
        acoustic: 0.6,
      },
      {
        source: "self_report",
        text: "thinking through this refactor",
        setAt: now,
      },
      {
        source: "git",
        commitsLastHour: 0,
        minSinceLastCommit: 190,
        filesDirty: 7,
        conflicted: true,
      },
    ],
  },
};

export interface ComposedScene {
  scene: DemoScene;
  state: StateWithCadence;
  block: string; // the exact <user_state> the hook would inject in this room
  board: string; // "pace=fast · tone=neutral · …"
  why: string; // effective nudge per dial — "pace←report.ship  posture←report.ship"
}

/** The effective rule per dial: application order in deriveCadenceTraced is
 * weakest-first, so the LAST trace entry for a dial is the one that stuck. */
export function effectiveNudges(nudges: NudgeFired[]): Partial<Record<keyof Cadence, string>> {
  const eff: Partial<Record<keyof Cadence, string>> = {};
  for (const n of nudges) eff[n.dial] = n.rule;
  return eff;
}

/** Run a scene through the real pipeline. `prompt` (when given) feeds the
 * live intent detector — the SAME prompt yields the same intent signal in
 * every room, so any difference between rooms is the room, not the wording. */
export function composeScene(
  scene: DemoScene,
  prompt: string | undefined,
  now: number
): ComposedScene {
  const signals = scene.signals(now);
  const kind = prompt ? detectPromptIntent(prompt) : null;
  if (kind) signals.push({ source: "intent", kind });

  const state: UserState = { signals, capturedAt: now };
  const { cadence, nudges } = deriveCadenceTraced(state);
  // Synthetic rooms carry no user pins — the demo shows pure inference.
  const full: StateWithCadence = {
    ...state,
    cadence,
    pinned: [],
    reframe: buildReframe(cadence),
  };

  const board = DIALS.map((d) => `${d}=${DIAL_WORDS[d][cadence[d]]}`).join(" · ");
  const eff = effectiveNudges(nudges);
  const why =
    DIALS.filter((d) => eff[d])
      .map((d) => `${d}←${eff[d]}`)
      .join("  ") || "all dials at neutral defaults";

  return { scene, state: full, block: render(full), board, why };
}

/* ── markdown emitter ──────────────────────────────────────────────────────
 * Deliberately plain: blockquotes and <details>, no styling — this output is
 * meant to be pasted into a README, not to compete with the site. */

export interface DemoRun extends ComposedScene {
  response?: string; // claude -p output; absent in a dry run
}

export interface DemoReport {
  prompt: string | undefined;
  runs: DemoRun[];
  baseline?: string; // control response with NO block injected
  model?: string;
  generatedAt: string; // ISO date
}

function quoteBlock(text: string): string {
  const body = text.trim();
  if (!body) return "> *(empty response)*";
  return body
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

export function renderDemoMarkdown(report: DemoReport): string {
  const lines: string[] = [];
  lines.push("# Same prompt, different room");
  lines.push("");
  if (report.prompt) {
    lines.push(`**Prompt (identical in every room):** ${JSON.stringify(report.prompt)}`);
  } else {
    lines.push("*(dry preview — no prompt given, blocks only)*");
  }
  lines.push("");
  lines.push(
    `*Generated by \`cadence demo\` on ${report.generatedAt}${
      report.model ? ` (model: ${report.model})` : ""
    }. Synthetic signals, real pipeline, unedited responses — re-run it yourself.*`
  );

  for (const run of report.runs) {
    lines.push("");
    lines.push(`## ${run.scene.label}`);
    lines.push("");
    lines.push(run.scene.blurb);
    lines.push("");
    lines.push(`**Board:** \`${run.board}\``);
    lines.push(`**Why:** \`${run.why}\``);
    lines.push("");
    lines.push("<details><summary>the injected <code>&lt;user_state&gt;</code></summary>");
    lines.push("");
    lines.push("```yaml");
    lines.push(run.block);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    if (run.response !== undefined) {
      lines.push("");
      lines.push(quoteBlock(run.response));
    }
  }

  if (report.baseline !== undefined) {
    lines.push("");
    lines.push("## Control — no Cadence");
    lines.push("");
    lines.push("Same prompt, nothing injected.");
    lines.push("");
    lines.push(quoteBlock(report.baseline));
  }

  lines.push("");
  return lines.join("\n");
}
