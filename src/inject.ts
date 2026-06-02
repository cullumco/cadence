import type {
  StateWithCadence,
  MusicSignal,
  SelfReportSignal,
  ActivitySignal,
  GitSignal,
  PlaceSignal,
} from "./types.js";
import { DIAL_WORDS } from "./cadence.js";

function renderMusic(m: MusicSignal): string[] {
  if (!m.track) return [];
  const lines = [
    `    music: "${m.track}"${m.artist ? ` — ${m.artist}` : ""}${
      m.player ? ` (${m.player})` : ""
    }`,
  ];
  if (m.vibe) lines.push(`    vibe: ${m.vibe}`);
  return lines;
}

function renderReport(r: SelfReportSignal): string {
  return `    self_report: "${r.text.replace(/"/g, '\\"')}"`;
}

function renderGit(g: GitSignal): string {
  const parts = [
    `commits_last_hour=${g.commitsLastHour}`,
    g.minSinceLastCommit != null ? `min_since_commit=${g.minSinceLastCommit}` : null,
    `files_dirty=${g.filesDirty}`,
    g.conflicted ? "conflicted=true" : null,
  ].filter(Boolean);
  return `    git: { ${parts.join(" ")} }`;
}

function renderActivity(a: ActivitySignal): string {
  const parts = [
    a.minSinceLastPrompt != null ? `min_since_prompt=${a.minSinceLastPrompt}` : null,
    a.promptLength != null ? `prompt_len=${a.promptLength}` : null,
  ].filter(Boolean);
  return `    activity: { ${parts.join(" ")} }`;
}

function renderPlace(p: PlaceSignal): string {
  const parts = [
    p.network ? `network="${p.network}"` : null,
    p.onBattery != null ? `on_battery=${p.onBattery}` : null,
    p.displays != null ? `displays=${p.displays}` : null,
    p.weather ? `weather="${p.weather}"` : null,
  ].filter(Boolean);
  return `    place: { ${parts.join(" ")} }`;
}

function renderCadence(
  c: StateWithCadence["cadence"],
  pinned: StateWithCadence["pinned"]
): string {
  const dials = (Object.keys(DIAL_WORDS) as (keyof typeof DIAL_WORDS)[])
    .map((d) => {
      const word = DIAL_WORDS[d][c[d]];
      return pinned.includes(d) ? `${d}=${word}*` : `${d}=${word}`;
    })
    .join(" ");
  return `    { ${dials} }`;
}

export function render(state: StateWithCadence): string {
  const lines: string[] = [];
  for (const sig of state.signals) {
    if (sig.source === "music") lines.push(...renderMusic(sig));
    else if (sig.source === "self_report") lines.push(renderReport(sig));
    else if (sig.source === "git") lines.push(renderGit(sig));
    else if (sig.source === "activity") lines.push(renderActivity(sig));
    else if (sig.source === "place") lines.push(renderPlace(sig));
  }
  // Render even with zero signals if the user pinned dials — a hand-set board
  // is itself a signal worth injecting.
  if (lines.length === 0 && state.pinned.length === 0) return "";

  // Evidence (signals) leads, then the dials, then the interpretation lens
  // composed from them. `*` marks a user-pinned dial (their determination,
  // higher authority than inference). The reframe still defers to literal words.
  const note = state.pinned.length
    ? "  # * = you set it; rest inferred from signals, advisory"
    : "  # inferred from signals, advisory";
  return [
    "<user_state>",
    `  signals:`,
    ...lines,
    `  cadence:${note}`,
    renderCadence(state.cadence, state.pinned),
    `  reframe: ${state.reframe}`,
    "</user_state>",
  ].join("\n");
}
