import { providerEnabled, providerSetting, type ProviderConfig } from "../config.js";
import { debug } from "../debug.js";
import type { EsotericSignal } from "../types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Esoteric flavor — opt-in, render-only. For people who want a little ambient
 * woo in the room. Never moves a dial (the BACKLOG lean): it colors the block,
 * it doesn't steer real work.
 *
 *   moon      → computed OFFLINE from the date, no API, no dep.
 *   horoscope → user sets their sign; daily text via a keyless API, opt-in and
 *               fail-silent, exactly like the weather probe. Absent on any
 *               hiccup, never throws.
 * ───────────────────────────────────────────────────────────────────────── */

const HOROSCOPE_TIMEOUT_MS = 900;
const SYNODIC_MONTH = 29.53058867; // days, new moon → new moon
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) / 1000; // 2000-01-06 reference

const PHASES = [
  "new moon",
  "waxing crescent",
  "first quarter",
  "waxing gibbous",
  "full moon",
  "waning gibbous",
  "last quarter",
  "waning crescent",
] as const;

const ZODIAC = new Set([
  "aries", "taurus", "gemini", "cancer", "leo", "virgo",
  "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces",
]);

/** Current moon phase as one of the 8 names. Pure + exported for tests. */
export function moonPhase(now: Date): string {
  const days = (now.getTime() / 1000 - KNOWN_NEW_MOON) / 86_400;
  const frac = (((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH) / SYNODIC_MONTH;
  const idx = Math.floor(frac * 8 + 0.5) % 8;
  return PHASES[idx]!;
}

async function fetchHoroscope(sign: string): Promise<string | undefined> {
  const s = sign.toLowerCase().trim();
  if (!ZODIAC.has(s)) return undefined; // garbage in → silent, never a guess
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOROSCOPE_TIMEOUT_MS);
  try {
    const url = `https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${s}&day=TODAY`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: { horoscope_data?: string } };
    const text = data.data?.horoscope_data;
    if (!text) return undefined;
    return text.length > 160 ? text.slice(0, 159).trimEnd() + "…" : text;
  } catch (e) {
    debug("esoteric", `horoscope lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function getEsotericSignal(
  providers: ProviderConfig,
  now: Date = new Date()
): Promise<EsotericSignal | null> {
  const moonOn = providerEnabled(providers, "moon");
  const sign = providerSetting(providers, "horoscope");
  if (!moonOn && typeof sign !== "string") return null; // nothing opted in

  const phase = moonOn ? moonPhase(now) : undefined;
  const horoscope = typeof sign === "string" ? await fetchHoroscope(sign) : undefined;
  if (!phase && !horoscope) return null;

  return {
    source: "esoteric",
    moonPhase: phase,
    horoscope,
    sign: typeof sign === "string" ? sign.toLowerCase().trim() : undefined,
  };
}
