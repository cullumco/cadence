import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MusicSignal } from "../types.js";
import { tagsToVibe } from "../vibe.js";

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

interface NowPlaying {
  track: string;
  artist: string;
  player: string;
}

// `application "X" is running` does NOT launch X — safe to probe.
const SCRIPT = `
on tryApp(appName)
  if application appName is running then
    tell application appName
      if player state is playing then
        return appName & "|||" & (name of current track) & "|||" & (artist of current track)
      end if
    end tell
  end if
  return ""
end tryApp
set r to tryApp("Spotify")
if r is "" then set r to tryApp("Music")
return r
`;

function osascript(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(
      `osascript -e ${JSON.stringify(script)}`,
      { timeout: 800 },
      (err, stdout) => resolve(err ? "" : stdout.trim())
    );
    child.on("error", () => resolve(""));
  });
}

async function getNowPlaying(): Promise<NowPlaying | null> {
  const out = await osascript(SCRIPT);
  if (!out) return null;
  const [player, track, artist] = out.split("|||");
  if (!track || !artist) return null;
  return { track, artist, player: player ?? "" };
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
  } catch {
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

export async function getMusicSignal(): Promise<MusicSignal | null> {
  const np = await getNowPlaying();
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
  };
}
