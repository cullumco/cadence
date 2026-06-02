import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AmbientSignal } from "../types.js";

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

async function getBattery(): Promise<boolean | undefined> {
  if (process.platform !== "darwin") return undefined;
  return new Promise((resolve) => {
    const child = exec("pmset -g batt", { timeout: 600 }, (err, stdout) => {
      if (err) return resolve(undefined);
      // "Now drawing from 'Battery Power'" vs "'AC Power'"
      if (/Battery Power/.test(stdout)) resolve(true);
      else if (/AC Power/.test(stdout)) resolve(false);
      else resolve(undefined);
    });
    child.on("error", () => resolve(undefined));
  });
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
  // weather + battery run in parallel; time/day are free and synchronous.
  const [weather, onBattery] = await Promise.all([getWeather(), getBattery()]);

  return {
    source: "ambient",
    partOfDay: partOfDay(hour),
    dayOfWeek: DAYS[now.getDay()] ?? "",
    isWeekend: now.getDay() === 0 || now.getDay() === 6,
    hour,
    weather,
    onBattery,
  };
}
