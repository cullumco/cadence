import type {
  StateWithCadence,
  MusicSignal,
  SelfReportSignal,
  ActivitySignal,
  IntentSignal,
  CalendarSignal,
  GitSignal,
  PlaceSignal,
  EnvironmentSignal,
  EsotericSignal,
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

function renderIntent(i: IntentSignal): string[] {
  if (!i.kind) return [];
  return [`    intent: ${i.kind} (read from your prompt)`];
}

// Minutes-only by default; the title only appears under its sub-opt-in.
// The provider already gates emission to the lookahead window, so no extra
// threshold here — one threshold source (the provider), never two.
function renderCalendar(c: CalendarSignal): string {
  const when =
    c.minutesToNextEvent <= 0 ? "starting now" : `in ${c.minutesToNextEvent}m`;
  return `    calendar: next event ${when}${c.eventTitle ? ` — ${quote(c.eventTitle)}` : ""}`;
}

function renderActivity(a: ActivitySignal): string {
  const parts = [
    a.minSinceLastPrompt != null ? `min_since_prompt=${a.minSinceLastPrompt}` : null,
    a.promptLength != null ? `prompt_len=${a.promptLength}` : null,
    a.tempo ? `tempo=${a.tempo}` : null,
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

// Human-readable atmosphere parts, e.g.
//   ["friday late night", "rainy", "unplugged 8%", "dark mode", "up 14h"]
// Exported so the TUI environment meter (src/tui.ts) shows the same condensed
// line the hook injects — one threshold source, never two.
export function environmentParts(a: EnvironmentSignal): string[] {
  return [
    a.isWeekend ? `${a.dayOfWeek} ${a.partOfDay}` : a.partOfDay,
    a.weather ?? null,
    a.onBattery === true
      ? `unplugged${a.batteryPct != null ? ` ${a.batteryPct}%` : ""}`
      : null,
    a.focus === true ? "focus on" : null,
    a.focusedApp ? `in ${quote(a.focusedApp)}` : null,
    a.darkMode === true ? "dark mode" : null,
    a.displays != null && a.displays > 1 ? `${a.displays} displays` : null,
    a.network ? `on ${quote(a.network)}` : null,
    a.loadHigh ? "machine busy" : null,
    a.uptimeHours != null && a.uptimeHours >= 12 ? `up ${a.uptimeHours}h` : null,
  ].filter(Boolean) as string[];
}

function renderEnvironment(a: EnvironmentSignal): string {
  return `    context: ${environmentParts(a).join(", ")}`;
}

function renderEsoteric(e: EsotericSignal): string[] {
  const parts = [
    e.moonPhase ? `moon ${e.moonPhase}` : null,
    e.horoscope ? `${e.sign ?? "horoscope"}: ${quote(e.horoscope)}` : null,
  ].filter(Boolean);
  return parts.length ? [`    esoteric: ${parts.join(" · ")}`] : [];
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
    else if (sig.source === "intent") lines.push(...renderIntent(sig));
    else if (sig.source === "calendar") lines.push(renderCalendar(sig));
    else if (sig.source === "activity") lines.push(renderActivity(sig));
    else if (sig.source === "place") lines.push(renderPlace(sig));
    else if (sig.source === "environment") lines.push(renderEnvironment(sig));
    else if (sig.source === "esoteric") lines.push(...renderEsoteric(sig));
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
