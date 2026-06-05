import type {
  MusicSignal,
  SelfReportSignal,
  GitSignal,
  AmbientSignal,
} from "./types.js";
import { STALE_AFTER_MS } from "./providers/selfreport.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Signals table — the legibility view behind `cadence signals`.
 *
 * Where `render()` (inject.ts) shows only what made the cut, this shows the
 * FULL shape: every signal Cadence knows how to read, its live value, and —
 * when it isn't in the injected block — exactly why (off, opt-in, threshold,
 * platform, not implemented). The "hidden:" notes mirror the thresholds in
 * inject.ts renderAmbient(); keep the two in sync when tuning.
 * ───────────────────────────────────────────────────────────────────────── */

export interface RawSignals {
  music: MusicSignal | null;
  report: SelfReportSignal | null;
  ambient: AmbientSignal | null;
  git: GitSignal | null;
  now: number; // injected so the view stays pure/testable
  platform: NodeJS.Platform; // ditto — decides "unavailable" vs "macOS only"
}

const LABEL_W = 12; // sub-row label column
const VALUE_W = 18; // value column, before a "(hidden: …)" note

function row(label: string, value: string, note?: string): string {
  const v = note ? `${value.padEnd(VALUE_W)} ${note}` : value;
  return `    ${label.padEnd(LABEL_W)}${v}`;
}

function top(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_W + 2)}${value}`;
}

function ttlLeft(setAt: number, now: number): string {
  const rem = Math.max(0, STALE_AFTER_MS - (now - setAt));
  const h = Math.floor(rem / 3_600_000);
  const m = Math.floor((rem % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m left` : `${m}m left`;
}

function ambientRows(a: AmbientSignal | null, platform: NodeJS.Platform): string[] {
  if (!a) return [top("ambient", "— unavailable")];
  const mac = platform === "darwin";
  const macNote = "— macOS only";

  const lines = ["  ambient"];
  lines.push(row("time", `${a.partOfDay} (${a.dayOfWeek})`));
  lines.push(
    row("weather", a.weather ?? "— off (run: cadence set-location <lat> <lon>)")
  );
  lines.push(
    !mac
      ? row("battery", macNote)
      : a.onBattery == null
        ? row("battery", "— unavailable")
        : a.onBattery
          ? row("battery", `unplugged${a.batteryPct != null ? `, ${a.batteryPct}%` : ""}`)
          : row(
              "battery",
              `plugged in${a.batteryPct != null ? `, ${a.batteryPct}%` : ""}`,
              "(hidden: only shows unplugged)"
            )
  );
  lines.push(
    !mac
      ? row("dark mode", macNote)
      : a.darkMode == null
        ? row("dark mode", "— unavailable")
        : a.darkMode
          ? row("dark mode", "on")
          : row("dark mode", "off", "(hidden: only shows on)")
  );
  lines.push(
    !mac
      ? row("displays", macNote)
      : a.displays == null
        ? row("displays", "— unavailable")
        : a.displays > 1
          ? row("displays", String(a.displays))
          : row("displays", String(a.displays), "(hidden: only shows >1)")
  );
  lines.push(
    !mac
      ? row("wifi", macNote)
      : a.network
        ? row("wifi", JSON.stringify(a.network))
        : row("wifi", "— unavailable")
  );
  lines.push(
    a.uptimeHours == null
      ? row("uptime", "— unavailable")
      : a.uptimeHours >= 12
        ? row("uptime", `${a.uptimeHours}h`)
        : row("uptime", `${a.uptimeHours}h`, "(hidden: only shows ≥12h)")
  );
  lines.push(
    a.loadHigh
      ? row("load", "high (machine busy)")
      : row("load", "normal", "(hidden: only shows high)")
  );
  lines.push(
    !mac
      ? row("focus", macNote)
      : a.focus == null
        ? row("focus", "— unavailable (terminal needs Full Disk Access)")
        : a.focus
          ? row("focus", "on")
          : row("focus", "off", "(hidden: only shows on)")
  );
  return lines;
}

function musicRows(m: MusicSignal | null): string[] {
  if (!m?.track) return [top("music", "— nothing playing")];
  const lines = ["  music"];
  lines.push(
    row(
      "track",
      `${JSON.stringify(m.track)}${m.artist ? ` — ${m.artist}` : ""}${m.player ? ` (${m.player})` : ""}`
    )
  );
  lines.push(m.vibe ? row("vibe", m.vibe) : row("vibe", "— no tags yet (looked up once per artist)"));
  return lines;
}

function reportRow(r: SelfReportSignal | null, now: number): string {
  if (!r) return top("self_report", '— none set (run: cadence state "...")');
  const text = r.text.length > 44 ? `${r.text.slice(0, 43)}…` : r.text;
  return top("self_report", `${JSON.stringify(text)} (${ttlLeft(r.setAt, now)})`);
}

function gitRow(g: GitSignal | null): string {
  if (!g) return top("git", "— not a git repo (signal is per-directory)");
  const parts = [
    g.commitsLastHour > 0
      ? `${g.commitsLastHour} commit${g.commitsLastHour === 1 ? "" : "s"}/hr`
      : null,
    g.filesDirty > 0 ? `${g.filesDirty} dirty` : "clean tree",
    g.minSinceLastCommit != null ? `last commit ${g.minSinceLastCommit}m ago` : null,
    g.conflicted ? "mid-conflict" : null,
  ].filter(Boolean);
  return top("git", parts.join(", "));
}

export function renderSignalsTable(raw: RawSignals): string {
  return [
    ...ambientRows(raw.ambient, raw.platform),
    ...musicRows(raw.music),
    reportRow(raw.report, raw.now),
    gitRow(raw.git),
    top("activity", "— session-only (the hook injects it per-prompt)"),
  ].join("\n");
}
