import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MusicSignal } from "../types.js";
import { tagsToVibe } from "../vibe.js";
import { getSpotifyNowPlaying } from "./spotify.js";
import { loadProviders, providerEnabled, type ProviderConfig } from "../config.js";
import { debug } from "../debug.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Music = identity + vibe. No Spotify Web API, no auth, no Premium.
 *
 *   1. osascript asks Spotify.app / Music.app what's playing (public,
 *      stable scripting interface — survives the macOS 15.4 MediaRemote
 *      lockdown that killed the system-wide now-playing tap).
 *   2. MusicBrainz turns the artist into crowd-sourced vibe tags
 *      (keyless, 1 req/sec). Cached forever by artist — a vibe never
 *      changes, so it's one network call per *new* artist, not per prompt.
 * ───────────────────────────────────────────────────────────────────────── */

const CACHE_FILE = join(homedir(), ".cadence", "vibe-cache.json");
const MB_TIMEOUT_MS = 1000;
const MAX_TAGS = 4;
const UA = "cadence/0.1 (https://github.com/cullumco/cadence)";

export interface NowPlaying {
  track: string;
  artist: string;
  player: string;
}

// Spotify first (matches historical priority), then Apple Music.
const PLAYERS = ["Spotify", "Music"] as const;

/* The app name MUST be a literal inside the script: AppleScript resolves
 * terms like `player state` against the target app's scripting dictionary
 * at COMPILE time, so `tell application someVariable` is a guaranteed
 * syntax error (-2741). One script per player, built from a template.
 * Exported for the compile-check regression test. */
export function playerScript(app: (typeof PLAYERS)[number]): string {
  return `
if application "${app}" is running then
  tell application "${app}"
    if player state is playing then
      return (name of current track) & "|||" & (artist of current track)
    end if
  end tell
end if
return ""
`;
}

/* Compiling `tell application "Spotify"` makes macOS locate the app — on a
 * machine where it isn't installed that can pop a "Where is Spotify?"
 * picker, from a background hook. pgrep the process list first so we only
 * ever compile scripts for players that are actually running. */
function isRunning(app: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("pgrep", ["-qx", app], { timeout: 500 }, (err) =>
      resolve(!err)
    );
    child.on("error", () => resolve(false));
  });
}

/* execFile, not exec: the script must reach osascript byte-for-byte as one
 * argv entry. Routing it through a shell means a quoting layer (where `\n`
 * inside double quotes stays a literal backslash-n — instant -2740). */
export function osascript(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "osascript",
      ["-e", script],
      { timeout: 800 },
      (err, stdout, stderr) => {
        if (err) debug("music", `osascript failed: ${stderr.trim() || err.message}`);
        resolve(err ? "" : stdout.trim());
      }
    );
    child.on("error", (e) => {
      debug("music", `osascript spawn failed: ${e.message}`);
      resolve("");
    });
  });
}

// macOS now-playing via the desktop apps' scripting interface. Darwin-only —
// osascript doesn't exist elsewhere; non-Mac falls through to MPRIS/Spotify.
async function getLocalNowPlaying(): Promise<NowPlaying | null> {
  if (process.platform !== "darwin") return null;
  for (const player of PLAYERS) {
    if (!(await isRunning(player))) {
      debug("music", `${player} not running`);
      continue;
    }
    const out = await osascript(playerScript(player));
    if (!out) continue; // running but paused/stopped (or script error, logged above)
    const [track, artist] = out.split("|||");
    if (!track || !artist) continue;
    return { track, artist, player };
  }
  return null;
}

/* ── macOS: Chrome audio (browser tabs + installed PWAs) ─────────────────────
 * Spotify.app/Music.app expose a scripting dictionary; a browser tab doesn't.
 * Two cheap, permission-light probes stand in for it:
 *   1. `pmset -g assertions` lists Chrome's "Playing audio" power assertion.
 *      Chrome hosts its PWAs in the same browser process, so this one check is
 *      true for a tab AND for an installed app (YouTube.app, YT Music.app).
 *   2. Chrome's AppleScript lists every window, PWA windows included (they show
 *      up as single-tab windows). The script filters to known media hosts
 *      INSIDE osascript, so non-media tab titles/URLs never reach Cadence.
 * Chrome doesn't say WHICH tab is audible (that needs "Allow JavaScript from
 * Apple Events", which we don't ask for), so the first media tab wins: active
 * tabs front to back, then background tabs. Opt-in: reading tab titles is a bigger ask than a player's
 * now-playing. */
export const CHROME_MEDIA_HOSTS = [
  "music.youtube.com", "youtube.com/watch", "soundcloud.com",
  "bandcamp.com", "open.spotify.com", "music.apple.com", "tidal.com",
];

export function chromeScript(): string {
  const tests = CHROME_MEDIA_HOSTS.map((h) => `u contains "${h}"`).join(" or ");
  // Two passes, front window first: every window's ACTIVE tab (a PWA window's
  // only tab, or what you're looking at), then BACKGROUND tabs, so a visible
  // player outranks a buried one. Chrome won't say which tab is audible.
  return `
if application "Google Chrome" is running then
  tell application "Google Chrome"
    set out to ""
    repeat with w in windows
      set t to active tab of w
      set u to URL of t
      if ${tests} then set out to out & (title of t) & "|||" & u & linefeed
    end repeat
    repeat with w in windows
      set ai to active tab index of w
      set n to count of tabs of w
      repeat with i from 1 to n
        if i is not ai then
          set t to tab i of w
          set u to URL of t
          if ${tests} then set out to out & (title of t) & "|||" & u & linefeed
        end if
      end repeat
    end repeat
    return out
  end tell
end if
return ""
`;
}

const SEP = /\s+[-\u2013\u2014]\s+/; // " - ", " \u2013 ", " \u2014 "

/* Pure parser over chromeScript's output, exported for tests. Strips YouTube's
 * "(3) " notification prefix and " - YouTube[ Music]" suffix, then reads
 * "Artist - Track". A title with no "Artist - Track" shape is only trusted on
 * a dedicated music host: a talk or a how-to on youtube.com is not music, and
 * its title would otherwise go to MusicBrainz as a fake artist. */
export function parseChromeMedia(out: string): NowPlaying | null {
  for (const line of out.split("\n")) {
    const [rawTitle, url = ""] = line.split("|||");
    if (!rawTitle) continue;
    const title = rawTitle
      .replace(/^\(\d+\)\s+/, "")
      .replace(/\s+-\s+YouTube( Music)?$/, "")
      .trim();
    const player = url.includes("music.youtube.com") ? "YouTube Music"
      : url.includes("youtube.com") ? "YouTube"
      : url.includes("soundcloud.com") ? "SoundCloud"
      : url.includes("bandcamp.com") ? "Bandcamp"
      : "Chrome";
    const parts = title.split(SEP);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      // "Queen - Bohemian Rhapsody (Official Video Remastered)"
      return { artist: parts[0].trim(), track: parts.slice(1).join(" - ").trim(), player };
    }
    if (player !== "YouTube" && player !== "Chrome") {
      return { artist: "", track: title, player }; // music host, no artist in title
    }
  }
  return null;
}

function chromeIsAudible(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile("pmset", ["-g", "assertions"], { timeout: 600 }, (err, out) =>
      resolve(!err && /\(Google Chrome\).*Playing audio/.test(out))
    );
    child.on("error", () => resolve(false));
  });
}

async function getChromeNowPlaying(providers: ProviderConfig): Promise<NowPlaying | null> {
  if (process.platform !== "darwin") return null;
  if (!providerEnabled(providers, "chromeAudio")) return null;
  if (!(await isRunning("Google Chrome"))) return null;
  if (!(await chromeIsAudible())) return null; // paused/muted: say nothing
  return parseChromeMedia(await osascript(chromeScript()));
}

/* ── Linux: MPRIS via playerctl ──────────────────────────────────────────────
 * playerctl speaks the MPRIS D-Bus spec, which Spotify and virtually every
 * Linux player implements — one probe covers them all, no per-player scripts.
 * `|||` mirrors the AppleScript separator above; status rides along so a
 * paused player reads as "nothing playing", same as the darwin path. */
const PLAYERCTL_FORMAT = "{{status}}|||{{playerName}}|||{{artist}}|||{{title}}";

/* Pure parser over playerctl's formatted output, exported for tests (the
 * platform gate + subprocess around it is a thin shell we can't run on CI
 * Macs). Only a Playing line with both artist and title yields a signal. */
export function parsePlayerctlOutput(out: string): NowPlaying | null {
  const line = out.split("\n")[0]?.trim(); // defensive: one active player expected
  if (!line) return null;
  const parts = line.split("|||");
  if (parts.length < 4) return null; // not our format (e.g. an error message)
  const [status, player, artist] = parts;
  const track = parts.slice(3).join("|||"); // title is last — may itself contain |||
  if (status !== "Playing") return null; // paused/stopped = nothing playing
  if (!artist || !track) return null;
  return { track, artist, player: player || "mpris" };
}

// execFile (not exec) + its own timeout, same discipline as osascript above.
// Missing binary (ENOENT), D-Bus errors, "No players found", timeouts — all
// resolve to "" and the parser turns that into null. stderr only via debug().
function playerctl(): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "playerctl",
      ["metadata", "--format", PLAYERCTL_FORMAT],
      { timeout: 800 },
      (err, stdout, stderr) => {
        if (err) debug("music", `playerctl failed: ${stderr.trim() || err.message}`);
        resolve(err ? "" : stdout.trim());
      }
    );
    child.on("error", (e) => {
      debug("music", `playerctl spawn failed: ${e.message}`);
      resolve("");
    });
  });
}

async function getLinuxNowPlaying(): Promise<NowPlaying | null> {
  if (process.platform !== "linux") return null;
  return parsePlayerctlOutput(await playerctl());
}

// Local players first (zero-setup: macOS scripting apps, Linux MPRIS); the
// opt-in Spotify token path last, so anyone who supplied creds still gets music.
async function getNowPlaying(providers: ProviderConfig): Promise<NowPlaying | null> {
  return (
    (await getLocalNowPlaying()) ??
    (await getChromeNowPlaying(providers)) ??
    (await getLinuxNowPlaying()) ??
    (await getSpotifyNowPlaying(providers))
  );
}

/* ── session history: sample every ~5 min, read the last ~30 ───────────────
 * One track is a snapshot; a work session is dozens of songs. A rolling log of
 * what was playing smooths the dials so a single outlier track (a ballad in a
 * metal session) doesn't flip pace/posture. Hooks are the only clock we have
 * (no daemon): the prompt hook records inline from the signal it already
 * collected, and PostToolUse/Stop spawn a detached sampler when a sample is
 * due, so a long agent run with no prompts still gets sampled. The log is a
 * WRITE, so only hooks write it; getMusicSignal (also used by read-only
 * surfaces) just reads it. `checkedAt` is stamped even when nothing is
 * playing, so silence doesn't re-trigger a probe on every tool call. */
export const CHECK_FAST_MS = 3 * 60_000; // while the track is changing
export const CHECK_SLOW_MS = 30 * 60_000; // once the same track has held across two checks
export const WINDOW_MS = 60 * 60_000;
const MAX_SAMPLES = 40;
const LOG_FILE = join(homedir(), ".cadence", "music-log.json");

export interface Sample extends NowPlaying {
  t: number;
}
export interface MusicLog {
  checkedAt: number;
  stable: boolean; // same track on two checks ≥ CHECK_FAST_MS apart → back off to CHECK_SLOW_MS
  samples: Sample[];
}

export function checkIntervalMs(log: Pick<MusicLog, "stable">): number {
  return log.stable ? CHECK_SLOW_MS : CHECK_FAST_MS;
}

export async function loadLog(): Promise<MusicLog> {
  try {
    const raw = JSON.parse(await readFile(LOG_FILE, "utf-8")) as Partial<MusicLog>;
    return {
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : 0,
      stable: raw.stable === true,
      samples: Array.isArray(raw.samples) ? raw.samples : [],
    };
  } catch {
    return { checkedAt: 0, stable: false, samples: [] };
  }
}

async function saveLog(log: MusicLog): Promise<void> {
  try {
    await mkdir(join(homedir(), ".cadence"), { recursive: true });
    await writeFile(LOG_FILE, JSON.stringify(log), "utf-8");
  } catch {
    // best-effort, like the vibe cache
  }
}

/* Pure: the window after folding in one observation. Drops samples older than
 * the window; skips a repeat of the same track within one fast interval (a
 * prompt burst shouldn't stack samples). Weight comes from duration, below. */
export function pushSample(samples: Sample[], np: NowPlaying, now: number): Sample[] {
  const kept = samples.filter((s) => now - s.t <= WINDOW_MS);
  const last = kept[kept.length - 1];
  const same = last && last.track === np.track && last.artist === np.artist;
  if (same && now - last.t < CHECK_FAST_MS) return kept;
  return [...kept, { t: now, track: np.track, artist: np.artist, player: np.player }].slice(-MAX_SAMPLES);
}

export interface WindowSummary {
  tracks: number; // distinct tracks in the window
  minutes: number; // span from the oldest sample to now
  energy?: number;
  acoustic?: number;
  vibe?: string;
}

/* Pure: average the cached genre tags' affect over the window. Samples whose
 * artist has no cached tags are skipped (no network on the read path); the
 * sampler warms the cache. */
export function summarizeWindow(
  samples: Sample[],
  cache: Record<string, string>,
  now: number
): WindowSummary | null {
  if (samples.length === 0) return null;
  const tracks = new Set(samples.map((s) => `${s.artist}\u0000${s.track}`)).size;
  const minutes = Math.max(0, Math.round((now - samples[0]!.t) / 60_000));
  // Weight each sample by how long it was playing (until the next sample, or
  // now), floored at one fast interval. Backing off to 30-minute checks means
  // a long mix has few samples but a lot of time; counting samples would let
  // three short songs outvote it.
  const rows = samples
    .map((s, i) => {
      const end = samples[i + 1]?.t ?? now;
      const c = s.artist ? cache[s.artist.toLowerCase()] : "";
      return { w: Math.max(end - s.t, CHECK_FAST_MS), v: c ? tagsToVibe(c.split(",")) : null };
    })
    .filter((r): r is { w: number; v: NonNullable<ReturnType<typeof tagsToVibe>> } => r.v != null);
  if (rows.length === 0) return { tracks, minutes };
  const total = rows.reduce((a, r) => a + r.w, 0);
  const mean = (f: (v: (typeof rows)[number]["v"]) => number) =>
    rows.reduce((a, r) => a + f(r.v) * r.w, 0) / total;
  const counts = new Map<string, number>();
  for (const r of rows) for (const m of r.v.moods) counts.set(m, (counts.get(m) ?? 0) + r.w);
  const moods = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m]) => m);
  return {
    tracks,
    minutes,
    energy: mean((v) => v.energy),
    acoustic: mean((v) => v.acoustic),
    ...(moods.length ? { vibe: moods.join(", ") } : {}),
  };
}

/* Record one observation (np = null: nothing playing). Called inline by the
 * prompt hook with the track it already has, and by the detached sampler. */
export async function recordMusic(np: NowPlaying | null, now = Date.now()): Promise<void> {
  const log = await loadLog();
  const last = log.samples[log.samples.length - 1];
  const sameTrack = np != null && last != null && last.track === np.track && last.artist === np.artist;
  // Back off only after the SAME track survives a full fast interval (a burst
  // of prompts a minute apart proves nothing); any change or silence snaps back.
  const stable = !np ? false : sameTrack ? log.stable || now - last!.t >= CHECK_FAST_MS : false;
  const samples = np
    ? pushSample(log.samples, np, now)
    : log.samples.filter((s) => now - s.t <= WINDOW_MS);
  await saveLog({ checkedAt: now, stable, samples });
  if (np?.artist) await getTags(np.artist); // warm the cache so history carries a vibe
}

/* The probe the detached helper runs. */
export async function sampleNow(now = Date.now()): Promise<void> {
  const providers = await loadProviders();
  await recordMusic(await getNowPlaying(providers), now);
}

/* Trigger side (PostToolUse/Stop): one tiny file read; spawns the detached
 * helper only when a check is due (3 min while the track changes, 30 once it
 * has held). The stamp goes down first so a burst of
 * tool calls spawns one helper, not one each. */
export async function maybeSpawnMusicSampler(now = Date.now()): Promise<boolean> {
  try {
    const log = await loadLog();
    if (now - log.checkedAt < checkIntervalMs(log)) return false;
    await saveLog({ ...log, checkedAt: now });
    const helper = fileURLToPath(new URL("../music-sample.js", import.meta.url));
    spawn(process.execPath, [helper], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

async function loadCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, string>): Promise<void> {
  try {
    await mkdir(join(homedir(), ".cadence"), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // cache is best-effort; never let it break the signal
  }
}

interface MBArtist {
  tags?: { count: number; name: string }[];
}
interface MBSearch {
  artists?: MBArtist[];
}

// Returns CLEANED genre tags (junk filtered out), most-popular first.
// We cache the tags, not the derived vibe — so tuning the vibe mapping
// (tagsToVibe / GENRE_AFFECT) takes effect immediately without flushing the cache.
async function fetchTags(artist: string): Promise<string[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MB_TIMEOUT_MS);
  try {
    const url =
      "https://musicbrainz.org/ws/2/artist/?fmt=json&limit=1&query=" +
      encodeURIComponent(`artist:"${artist}"`);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MBSearch;
    const tags = data.artists?.[0]?.tags;
    if (!tags || tags.length === 0) return null;
    const cleaned = tags
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((t) => t.name)
      .filter((name) => isVibeTag(name, artist))
      .slice(0, MAX_TAGS);
    return cleaned.length ? cleaned : null;
  } catch (e) {
    debug("music", `musicbrainz lookup failed for "${artist}": ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* A "vibe" is an adjective or genre — never a proper noun, place, or
 * listener-org meta-tag. Blocklist (not allowlist) so novel genres
 * (hyperpop, phonk, …) pass; we only reject known classes of junk. */
const META_TAG = /^(seen live|favou?rites?|spotify|owned|albums i own|under \d+|my |male |female )/;
const PLACES = new Set([
  "toronto", "london", "uk", "usa", "us", "american", "british", "canadian",
  "swedish", "german", "french", "australian", "japanese", "korean",
  "english", "scottish", "irish", "norwegian", "icelandic", "dutch",
]);

function isVibeTag(tag: string, artist: string): boolean {
  const t = tag.toLowerCase().trim();
  if (t.length < 2 || t.length > 30) return false; // empty or essay-length
  const nameWords = new Set(artist.toLowerCase().split(/\s+/));
  if (nameWords.has(t)) return false; // "daniel", "caesar"
  if (PLACES.has(t)) return false; // geography is trivia, not vibe
  if (META_TAG.test(t)) return false; // listener-org cruft
  return true;
}

// Cache stores the cleaned tags as a comma-joined string (""=known-empty).
async function getTags(artist: string): Promise<string[]> {
  const key = artist.toLowerCase();
  const cache = await loadCache();
  if (key in cache) {
    const v = cache[key] ?? "";
    return v ? v.split(",") : [];
  }
  const tags = await fetchTags(artist);
  cache[key] = (tags ?? []).join(","); // cache empty too — don't re-hit MB every prompt
  await saveCache(cache);
  return tags ?? [];
}

export async function getMusicSignal(
  providers?: ProviderConfig
): Promise<MusicSignal | null> {
  const np = await getNowPlaying(providers ?? (await loadProviders()));
  if (!np) return null;

  const tags = np.artist ? await getTags(np.artist) : []; // no artist → no MusicBrainz lookup
  const vibe = tags.length ? tagsToVibe(tags) : null;

  // Smooth over the session: fold the current track into the logged window
  // (in memory only — this getter also serves read-only surfaces) and, once
  // the window holds 2+ distinct tracks, let it set the dials.
  const now = Date.now();
  const log = await loadLog();
  const win = summarizeWindow(pushSample(log.samples, np, now), await loadCache(), now);
  const smoothed = win != null && win.tracks >= 2 && win.energy != null;

  return {
    source: "music",
    track: np.track,
    artist: np.artist,
    player: np.player || undefined,
    vibe: smoothed ? win.vibe : vibe && vibe.moods.length ? vibe.moods.join(", ") : undefined,
    energy: smoothed ? win.energy : vibe?.energy,
    acoustic: smoothed ? win.acoustic : vibe?.acoustic,
    ...(win && win.tracks >= 2 ? { recent: `${win.tracks} tracks in ${win.minutes}m` } : {}),
  };
}
