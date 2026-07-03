import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MusicSignal } from "../types.js";
import { tagsToVibe } from "../vibe.js";
import { getSpotifyNowPlaying } from "./spotify.js";
import { loadProviders, type ProviderConfig } from "../config.js";
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
    (await getLinuxNowPlaying()) ??
    (await getSpotifyNowPlaying(providers))
  );
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

  const tags = await getTags(np.artist);
  const vibe = tags.length ? tagsToVibe(tags) : null;

  return {
    source: "music",
    track: np.track,
    artist: np.artist,
    player: np.player || undefined,
    vibe: vibe && vibe.moods.length ? vibe.moods.join(", ") : undefined,
    energy: vibe?.energy,
    acoustic: vibe?.acoustic,
  };
}
