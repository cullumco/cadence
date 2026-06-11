import type {
  StateWithCadence,
  MusicSignal,
  SelfReportSignal,
  ActivitySignal,
  GitSignal,
  PlaceSignal,
  EnvironmentSignal,
  MoonSignal,
} from "./types.js";
import { DIAL_WORDS } from "./cadence.js";

function quote(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function renderMusic(m: MusicSignal): string[] {
  if (!m.track) return [];
  const lines = [
    `    music: ${quote(m.track)}${m.artist ? ` — ${quote(m.artist)}` : ""}${
      m.player ? ` (${quote(m.player)})` : ""
    }`,
  ];
  if (m.vibe) lines.push(`    vibe: ${m.vibe}`);
  return lines;
}

function renderReport(r: SelfReportSignal): string {
  return `    self_report: ${quote(r.text)}`;
}

function renderGit(g: GitSignal): string {
  // Human-readable work-state, e.g. "3 commits/hr, 5 dirty, mid-merge"
  const parts = [
    g.commitsLastHour > 0 ? `${g.commitsLastHour} commit${g.commitsLastHour === 1 ? "" : "s"}/hr` : null,
    g.filesDirty > 0 ? `${g.filesDirty} dirty` : "clean tree",
    g.minSinceLastCommit != null ? `last commit ${g.minSinceLastCommit}m ago` : null,
    g.conflicted ? "mid-conflict" : null,
  ].filter(Boolean);
  return `    git: ${parts.join(", ")}`;
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
    p.network ? `network=${quote(p.network)}` : null,
    p.displays != null ? `displays=${p.displays}` : null,
  ].filter(Boolean);
  return `    place: { ${parts.join(" ")} }`;
}

function renderEnvironment(a: EnvironmentSignal): string {
  // Human-readable atmosphere line, e.g.
  //   "friday late night, rainy, unplugged 8%, dark mode, on Home-wifi, up 14h"
  const parts = [
    a.isWeekend ? `${a.dayOfWeek} ${a.partOfDay}` : a.partOfDay,
    a.weather ?? null,
    a.onBattery === true
      ? `unplugged${a.batteryPct != null ? ` ${a.batteryPct}%` : ""}`
      : null,
    a.focus === true ? "focus on" : null,
    a.darkMode === true ? "dark mode" : null,
    a.displays != null && a.displays > 1 ? `${a.displays} displays` : null,
    a.network ? `on ${quote(a.network)}` : null,
    a.loadHigh ? "machine busy" : null,
    a.uptimeHours != null && a.uptimeHours >= 12 ? `up ${a.uptimeHours}h` : null,
  ].filter(Boolean);
  return `    context: ${parts.join(", ")}`;
}

function renderMoon(m: MoonSignal): string {
  // Opt-in flavor, e.g. "moon: waxing gibbous (78% lit)". Skip the redundant
  // percentage at the extremes — "new (2% lit)" reads like a malfunction.
  const pct =
    m.phase === "new" || m.phase === "full" ? "" : ` (${m.illumination}% lit)`;
  return `    moon: ${m.phase}${pct}`;
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
    else if (sig.source === "environment") lines.push(renderEnvironment(sig));
    else if (sig.source === "moon") lines.push(renderMoon(sig));
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
