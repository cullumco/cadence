import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerSetting, type ProviderConfig } from "../config.js";
import { debug } from "../debug.js";
import type { CalendarSignal } from "../types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Calendar proximity — opt-in, cross-platform, keyless.
 *
 * "Next meeting in 12 minutes" is the most legible wrap-up nudge there is.
 * The user pastes their secret ICS feed URL (Google/Outlook both export one):
 *
 *   cadence calendar set-url <ics-url>
 *
 * Follows the weather pattern exactly: URL lives in ~/.cadence/config.json
 * (providers.calendar), the feed is fetched with a short AbortController
 * timeout, and PARSED events are cached in ~/.cadence/calendar-cache.json so
 * the prompt + stop hooks never double-fetch — the hook only ever reads
 * cache-or-one-quick-fetch.
 *
 * Privacy: the signal defaults to MINUTES ONLY. Event titles are a separate
 * sub-opt-in (`cadence calendar titles on`) because the URL grants us the
 * title but the user may not want "Interview — Acme" injected into every
 * prompt (or written to the local cache). Titles off ⇒ stripped BEFORE the
 * cache is written, so they never touch disk either.
 *
 * ICS parsing is deliberately minimal (v1, no runtime deps):
 *   - DTSTART / DTEND / SUMMARY on non-recurring VEVENTs
 *   - RRULE/RDATE events are SKIPPED (expanding recurrences correctly needs
 *     a real library; a wrong "meeting in 10m" is worse than silence)
 *   - all-day events (VALUE=DATE) are skipped — a date isn't a meeting time
 *   - times: `...Z` = UTC; TZID=<zone> converted via Intl (falls back to
 *     local wall-time on unknown zones); no param = floating local time
 * ───────────────────────────────────────────────────────────────────────── */

const CALENDAR_TIMEOUT_MS = 900;
// Exported so the CLI can clear it on `calendar off` / `titles off` — cached
// titles must not linger on disk after the user withdraws that consent.
export const CALENDAR_CACHE_FILE = join(homedir(), ".cadence", "calendar-cache.json");
// ICS feeds barely move in 20 minutes, and the prompt + stop hooks both ask —
// without a cache that's two feed round-trips per turn.
export const CALENDAR_CACHE_MS = 20 * 60_000;
// Only speak when the next event is close enough to matter for THIS session.
export const CALENDAR_LOOKAHEAD_MIN = 120;

export interface IcsEvent {
  start: number; // epoch ms
  end?: number; // epoch ms
  title?: string;
}

interface CalendarCache {
  at: number;
  url: string;
  events: IcsEvent[];
}

/* Pure freshness check, exported for tests: same feed, younger than TTL. */
export function calendarCacheFresh(
  c: unknown,
  url: string,
  now: number
): c is CalendarCache {
  if (!c || typeof c !== "object") return false;
  const cc = c as Partial<CalendarCache>;
  return (
    typeof cc.at === "number" &&
    cc.url === url &&
    Array.isArray(cc.events) &&
    now - cc.at <= CALENDAR_CACHE_MS
  );
}

// Wall-clock time in an IANA zone → epoch ms, via Intl (no tz database dep).
// Compute the zone's offset at a UTC guess, correct, and refine once for the
// rare DST-boundary case. Throws on unknown zones (caller falls back).
function zonedToEpoch(
  y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string
): number {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (utc: number): number => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(utc))) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]),
      Number(p["hour"]) % 24, Number(p["minute"]), Number(p["second"])
    );
    return asUtc - utc;
  };
  let epoch = wallAsUtc - offsetAt(wallAsUtc);
  epoch = wallAsUtc - offsetAt(epoch); // refine across a DST edge
  return epoch;
}

// One ICS date-time property value → epoch ms, or null when unusable.
// `params` is the raw parameter string between the property name and the `:`
// (e.g. ";TZID=America/New_York" or ";VALUE=DATE").
export function parseIcsDate(value: string, params: string): number | null {
  if (/VALUE=DATE(?:;|$)/i.test(params.replace(/^;/, ""))) return null; // all-day → skip
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null; // bare DATE values (all-day) land here too
  const [, y, mo, d, h, mi, s, z] = m;
  const nums = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  if (z === "Z") return Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]);
  const tzid = params.match(/TZID=([^;:]+)/i)?.[1];
  if (tzid) {
    try {
      return zonedToEpoch(nums[0], nums[1], nums[2], nums[3], nums[4], nums[5], tzid.trim());
    } catch {
      // unknown zone → best-effort: read it as local wall time below
    }
  }
  return new Date(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]).getTime();
}

function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? " " : c));
}

/* Minimal ICS → events. Pure + exported for fixture tests. Anything the
 * parser doesn't understand is dropped, never guessed. */
export function parseIcs(text: string): IcsEvent[] {
  // RFC 5545 line unfolding: CRLF (or LF) followed by a space/tab continues
  // the previous line.
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: IcsEvent[] = [];
  let cur: { start?: number; end?: number; title?: string; recurring?: boolean } | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      cur = {};
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (cur && cur.start != null && !cur.recurring) {
        const ev: IcsEvent = { start: cur.start };
        if (cur.end != null) ev.end = cur.end;
        if (cur.title) ev.title = cur.title;
        events.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^(DTSTART|DTEND|SUMMARY|RRULE|RDATE)([^:]*):(.*)$/i);
    if (!m) continue;
    const [, prop = "", params = "", value = ""] = m;
    switch (prop.toUpperCase()) {
      case "RRULE":
      case "RDATE":
        cur.recurring = true; // v1: skip recurring events rather than mis-expand
        break;
      case "DTSTART": {
        const t = parseIcsDate(value, params);
        if (t == null) cur.recurring = true; // unusable start (e.g. all-day) → drop event
        else cur.start = t;
        break;
      }
      case "DTEND": {
        const t = parseIcsDate(value, params);
        if (t != null) cur.end = t;
        break;
      }
      case "SUMMARY":
        cur.title = unescapeText(value.trim());
        break;
    }
  }
  events.sort((a, b) => a.start - b.start);
  return events;
}

/* The next FUTURE event start within the lookahead window. In-progress events
 * are deliberately ignored — the nudge is wrap-up pressure BEFORE a meeting,
 * not commentary on one you're already in. Pure + exported for tests. */
export function nextEvent(
  events: IcsEvent[],
  nowMs: number
): { minutes: number; title?: string } | null {
  let best: IcsEvent | null = null;
  for (const ev of events) {
    if (ev.start < nowMs) continue;
    if (!best || ev.start < best.start) best = ev;
  }
  if (!best) return null;
  const minutes = Math.floor((best.start - nowMs) / 60_000);
  if (minutes > CALENDAR_LOOKAHEAD_MIN) return null;
  return best.title ? { minutes, title: best.title } : { minutes };
}

// providers.calendar accepts either the object form ({ ics, titles }) written
// by `cadence calendar set-url`, or a bare URL string from `cadence enable
// calendar <url>`. Anything else reads as "off".
export function calendarConfig(
  setting: unknown
): { ics: string; titles: boolean } | null {
  if (typeof setting === "string" && /^https?:\/\//.test(setting)) {
    return { ics: setting, titles: false };
  }
  if (setting && typeof setting === "object") {
    const s = setting as { ics?: unknown; titles?: unknown };
    if (typeof s.ics === "string" && /^https?:\/\//.test(s.ics)) {
      return { ics: s.ics, titles: s.titles === true };
    }
  }
  return null;
}

async function fetchEvents(url: string, keepTitles: boolean): Promise<IcsEvent[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALENDAR_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const events = parseIcs(await res.text());
    // Titles off ⇒ strip them HERE, before anything is cached — they never
    // touch disk, not just never the injected block.
    return keepTitles ? events : events.map(({ start, end }) => (end != null ? { start, end } : { start }));
  } catch (e) {
    debug("calendar", `feed fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCalendarSignal(
  providers: ProviderConfig,
  now: Date = new Date()
): Promise<CalendarSignal | null> {
  const cfg = calendarConfig(providerSetting(providers, "calendar"));
  if (!cfg) return null; // not opted in (or a garbled setting) → silent

  let events: IcsEvent[] | null = null;
  try {
    const cached: unknown = JSON.parse(await readFile(CALENDAR_CACHE_FILE, "utf-8"));
    if (calendarCacheFresh(cached, cfg.ics, now.getTime())) events = cached.events;
  } catch {
    // no cache yet → fetch below
  }

  if (!events) {
    events = await fetchEvents(cfg.ics, cfg.titles);
    if (!events) return null; // network hiccup → no signal, never an error
    try {
      // best-effort cache write; a miss just means we fetch again next prompt
      await mkdir(join(homedir(), ".cadence"), { recursive: true });
      const cache: CalendarCache = { at: now.getTime(), url: cfg.ics, events };
      await writeFile(CALENDAR_CACHE_FILE, JSON.stringify(cache), "utf-8");
    } catch {
      // ignore
    }
  }

  const next = nextEvent(events, now.getTime());
  if (!next) return null;
  return {
    source: "calendar",
    minutesToNextEvent: next.minutes,
    // double-gate: the cache already stripped titles when the sub-opt-in is
    // off, but a stale cache written while titles were on must not leak either
    ...(cfg.titles && next.title ? { eventTitle: next.title } : {}),
  };
}
