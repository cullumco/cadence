import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, uptime, loadavg, cpus } from "node:os";
import { join } from "node:path";
import type { AmbientSignal } from "../types.js";

// One-liner shell helper for the best-effort macOS probes. Always resolves
// (never throws) so a missing command can't break the hook.
function sh(cmd: string, ms = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: ms, windowsHide: true }, (err, out) =>
      resolve(err ? null : out.trim())
    );
    child.on("error", () => resolve(null));
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Ambient context provider — the cheapest signals, biggest reach.
 *
 *   time + day  → always available, every OS, no deps, never fails. This is
 *                 the signal that makes Cadence do something for everyone.
 *   weather     → opt-in: only if ~/.cadence/config.json has a location.
 *                 Keyless via Open-Meteo. No silent geolocation.
 *   battery     → macOS pmset, best-effort.
 *
 * "Put the vibes back into engineering": this is the atmosphere layer.
 * ───────────────────────────────────────────────────────────────────────── */

const CONFIG_FILE = join(homedir(), ".cadence", "config.json");
const DND_ASSERTIONS = join(homedir(), "Library", "DoNotDisturb", "DB", "Assertions.json");
const WEATHER_TIMEOUT_MS = 900;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function partOfDay(hour: number): AmbientSignal["partOfDay"] {
  if (hour < 5) return "late night";
  if (hour < 9) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late night";
}

async function getBattery(): Promise<{ onBattery?: boolean; pct?: number }> {
  if (process.platform !== "darwin") return {};
  const out = await sh("pmset -g batt", 600);
  if (!out) return {};
  const onBattery = /Battery Power/.test(out)
    ? true
    : /AC Power/.test(out)
      ? false
      : undefined;
  const pctMatch = out.match(/(\d+)%/);
  const pct = pctMatch ? Number(pctMatch[1]) : undefined;
  return { onBattery, pct };
}

// ── machine vitals: pure Node, cross-platform, effectively free ──────────────
function getVitals(): { uptimeHours: number; loadHigh: boolean } {
  const uptimeHours = Math.round((uptime() / 3600) * 10) / 10;
  // 1-min load average relative to core count; >0.8/core ⇒ busy.
  const cores = Math.max(1, cpus().length);
  const load1 = loadavg()[0] ?? 0;
  return { uptimeHours, loadHigh: load1 / cores > 0.8 };
}

// Focus / DND — tri-state, read straight from the private donotdisturbd DB
// (~1ms, no subprocess). Exported for the darwin smoke test.
//   true      → a Focus mode is asserted (manually toggled on this device)
//   false     → file read OK, no assertion records → focus is off
//   undefined → unreadable: terminal lacks Full Disk Access (TCC denies the
//               read silently — hook subprocesses never get a prompt), file
//               moved, or shape changed → "unavailable", never "off"
// Known gap: SCHEDULED/geofenced Focus writes no assertion record (detecting
// it needs ModeConfigurations.json schedule math — backlogged).
export async function getFocus(): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const raw = await readFile(DND_ASSERTIONS, "utf-8");
    const json = JSON.parse(raw) as { data?: { storeAssertionRecords?: unknown[] }[] };
    const records = json.data?.[0]?.storeAssertionRecords;
    return Array.isArray(records) && records.length > 0;
  } catch {
    return undefined;
  }
}

// ── mac context: best-effort shell-outs, all flavor (no dial nudges) ─────────
async function getMacContext(): Promise<{
  focus?: boolean;
  displays?: number;
  network?: string;
  darkMode?: boolean;
}> {
  if (process.platform !== "darwin") return {};
  const [dark, ssid, displays, focus] = await Promise.all([
    sh("defaults read -g AppleInterfaceStyle"), // "Dark", or error (=light)
    sh("ipconfig getsummary en0 | awk -F ' SSID : ' '/ SSID : / {print $2}'", 700),
    // fast display count via AppleScript (~100ms) — NOT system_profiler (1-3s)
    sh(`osascript -e 'tell application "System Events" to count of desktops'`, 700),
    getFocus(),
  ]);

  const ctx: { focus?: boolean; displays?: number; network?: string; darkMode?: boolean } = {};
  // `defaults read` exits non-zero when the key is unset — which is exactly
  // what light mode looks like. So error/null ⇒ light, not unknown.
  ctx.darkMode = dark != null && /dark/i.test(dark);
  ctx.focus = focus;
  if (ssid) ctx.network = ssid.split("\n")[0]?.trim() || undefined;
  const n = displays ? Number(displays) : NaN;
  if (Number.isFinite(n) && n > 0) ctx.displays = n;
  return ctx;
}

interface CadenceConfig {
  location?: { lat: number; lon: number; name?: string };
}

// WMO weather codes → a single human word. Open-Meteo returns these.
function weatherWord(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "rainy";
  if (code <= 86) return "snowy";
  return "stormy";
}

async function getWeather(): Promise<string | undefined> {
  let cfg: CadenceConfig;
  try {
    cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as CadenceConfig;
  } catch {
    return undefined; // no config → weather is simply off
  }
  const loc = cfg.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") return undefined;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}` +
      `&longitude=${loc.lon}&current=weather_code`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { current?: { weather_code?: number } };
    const code = data.current?.weather_code;
    return typeof code === "number" ? weatherWord(code) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function getAmbientSignal(now: Date): Promise<AmbientSignal> {
  const hour = now.getHours();
  const vitals = getVitals(); // sync, free
  // all probes run in parallel; each resolves to a safe default on failure.
  const [weather, battery, mac] = await Promise.all([
    getWeather(),
    getBattery(),
    getMacContext(),
  ]);

  return {
    source: "ambient",
    partOfDay: partOfDay(hour),
    dayOfWeek: DAYS[now.getDay()] ?? "",
    isWeekend: now.getDay() === 0 || now.getDay() === 6,
    hour,
    weather,
    onBattery: battery.onBattery,
    batteryPct: battery.pct,
    uptimeHours: vitals.uptimeHours,
    loadHigh: vitals.loadHigh,
    focus: mac.focus,
    displays: mac.displays,
    network: mac.network,
    darkMode: mac.darkMode,
  };
}
