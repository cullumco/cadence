import type {
  MusicSignal,
  SelfReportSignal,
  GitSignal,
  EnvironmentSignal,
} from "./types.js";
import { STALE_AFTER_MS } from "./providers/selfreport.js";
import { providerEnabled, providerSetting, type ProviderConfig } from "./config.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Signals table — the legibility view behind `cadence signals`.
 *
 * Where `render()` (inject.ts) shows only what made the cut, this shows the
 * FULL shape: every signal Cadence knows how to read, its live value, and —
 * when it isn't in the injected block — exactly why (off, opt-in, threshold,
 * platform, not implemented). The "hidden:" notes mirror the thresholds in
 * inject.ts renderEnvironment(); keep the two in sync when tuning.
 * ───────────────────────────────────────────────────────────────────────── */

export interface RawSignals {
  music: MusicSignal | null;
  report: SelfReportSignal | null;
  environment: EnvironmentSignal | null;
  git: GitSignal | null;
  now: number; // injected so the view stays pure/testable
  platform: NodeJS.Platform; // ditto — decides "unavailable" vs "macOS only"
  providers?: ProviderConfig; // the opt-in registry, for "on/off" on opt-in signals
}

export const LABEL_W = 12; // sub-row label column (the TUI aligns to it too)
const VALUE_W = 18; // value column, before a "(hidden: …)" note

function row(label: string, value: string, note?: string): string {
  const v = note ? `${value.padEnd(VALUE_W)} ${note}` : value;
  return `    ${label.padEnd(LABEL_W)}${v}`;
}

function top(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_W + 2)}${value}`;
}

export function ttlLeft(setAt: number, now: number): string {
  const rem = Math.max(0, STALE_AFTER_MS - (now - setAt));
  const h = Math.floor(rem / 3_600_000);
  const m = Math.floor((rem % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m left` : `${m}m left`;
}

/* Value formatters shared with the TUI meters (src/tui.ts) — one source of
 * truth so the board and `cadence signals` can never drift apart. */
export function musicValue(m: MusicSignal): string {
  return `${JSON.stringify(m.track)}${m.artist ? ` — ${m.artist}` : ""}${m.player ? ` (${m.player})` : ""}`;
}

export function reportValue(r: SelfReportSignal, now: number): string {
  const text = r.text.length > 44 ? `${r.text.slice(0, 43)}…` : r.text;
  return `${JSON.stringify(text)} (${ttlLeft(r.setAt, now)})`;
}

export function gitValue(g: GitSignal): string {
  const parts = [
    g.commitsLastHour > 0
      ? `${g.commitsLastHour} commit${g.commitsLastHour === 1 ? "" : "s"}/hr`
      : null,
    g.filesDirty > 0 ? `${g.filesDirty} dirty` : "clean tree",
    g.minSinceLastCommit != null ? `last commit ${g.minSinceLastCommit}m ago` : null,
    g.conflicted ? "mid-conflict" : null,
  ].filter(Boolean);
  return parts.join(", ");
}

function environmentRows(
  a: EnvironmentSignal | null,
  platform: NodeJS.Platform,
  providers: ProviderConfig
): string[] {
  if (!a) return [top("environment", "— unavailable")];
  const mac = platform === "darwin";
  const macNote = "— macOS only";

  const lines = ["  environment"];
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
      : !providerEnabled(providers, "wifi")
        ? row("wifi", "— off (run: cadence enable wifi)")
        : a.network
          ? row("wifi", JSON.stringify(a.network))
          : row("wifi", "— unavailable (macOS may require Location Services)")
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

function musicRows(m: MusicSignal | null, providers: ProviderConfig): string[] {
  const spotify = providerEnabled(providers, "spotify")
    ? row("source", "macOS apps + Spotify (cross-platform, linked)")
    : row("source", "macOS apps only", "(cross-platform: cadence spotify)");
  if (!m?.track) return [top("music", "— nothing playing"), spotify];
  const lines = ["  music"];
  lines.push(row("track", musicValue(m)));
  lines.push(m.vibe ? row("vibe", m.vibe) : row("vibe", "— no tags yet (looked up once per artist)"));
  lines.push(spotify);
  return lines;
}

function reportRow(r: SelfReportSignal | null, now: number): string {
  if (!r) return top("self_report", '— none set (run: cadence report "...")');
  return top("self_report", reportValue(r, now));
}

function gitRow(g: GitSignal | null): string {
  if (!g) return top("git", "— not a git repo (signal is per-directory)");
  return top("git", gitValue(g));
}

function intentRow(): string {
  return top("intent", "— reads your prompt (the hook infers ship/think/debug per-prompt)");
}

function tempoRow(providers: ProviderConfig): string {
  return providerEnabled(providers, "typingTempo")
    ? top("typing tempo", "on (opt-in) — rapid vs. considered prompt rhythm → pace")
    : top("typing tempo", "— off (opt-in: cadence enable typingTempo)");
}

function optInFlavorRows(providers: ProviderConfig, environment: EnvironmentSignal | null): string[] {
  const sign = providerSetting(providers, "horoscope");
  return [
    "  opt-in flavor",
    row(
      "focused app",
      providerEnabled(providers, "focusedApp")
        ? environment?.focusedApp ?? "on — nothing non-terminal in front"
        : "— off (cadence enable focusedApp)"
    ),
    row(
      "moon",
      providerEnabled(providers, "moon")
        ? "on — phase shows in the block"
        : "— off (cadence enable moon)"
    ),
    row(
      "horoscope",
      typeof sign === "string"
        ? `on (${sign}) — daily text shows in the block`
        : "— off (cadence enable horoscope <sign>)"
    ),
  ];
}

export function renderSignalsTable(raw: RawSignals): string {
  const providers = raw.providers ?? {};
  return [
    ...environmentRows(raw.environment, raw.platform, raw.providers ?? {}),
    ...musicRows(raw.music, providers),
    reportRow(raw.report, raw.now),
    intentRow(),
    gitRow(raw.git),
    top("activity", "— session-only (the hook injects it per-prompt)"),
    tempoRow(providers),
    ...optInFlavorRows(providers, raw.environment),
  ].join("\n");
}
