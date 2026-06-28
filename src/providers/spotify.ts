import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerEnabled, type ProviderConfig } from "../config.js";
import { debug } from "../debug.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Spotify now-playing — the CROSS-PLATFORM music source (opt-in).
 *
 * macOS already reads Spotify.app / Music.app via AppleScript; this is for the
 * Linux/Windows user (or anyone who'd rather not script the desktop app). It
 * is NOT the deprecated audio-features API — only `currently-playing`, which
 * is still live. Vibe still comes from MusicBrainz downstream, so this returns
 * identity only (track + artist), exactly like the AppleScript path.
 *
 * Opt-in and BYO-credentials — no shared client, no callback server in a
 * background hook. The user registers their own Spotify app and supplies a
 * refresh token + client id (see `cadence spotify`); we refresh the short-lived
 * access token ourselves and cache it so a normal prompt makes ONE request.
 * Fail-silent throughout: any hiccup degrades to "no music," never throws.
 * ───────────────────────────────────────────────────────────────────────── */

const TOKEN_CACHE = join(homedir(), ".cadence", "spotify-token.json");
const REFRESH_TIMEOUT_MS = 800;
const NOWPLAYING_TIMEOUT_MS = 800;
const TOKEN_SKEW_MS = 60_000; // refresh a minute early so a live token can't expire mid-flight

export interface SpotifyCreds {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  /** Space-separated OAuth scopes recorded at link time; absent = a legacy
   * read-only link. The DJ checks this and fails closed without it. */
  scopes?: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export interface NowPlaying {
  track: string;
  artist: string;
  player: string;
}

/** Pull and validate the Spotify creds out of the provider registry, or null
 * when the user hasn't opted in / the shape is incomplete. Pure + exported. */
export function readCreds(providers: ProviderConfig): SpotifyCreds | null {
  if (!providerEnabled(providers, "spotify")) return null;
  const v = providers["spotify"];
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const refreshToken = o["refreshToken"];
  const clientId = o["clientId"];
  if (typeof refreshToken !== "string" || typeof clientId !== "string") return null;
  if (!refreshToken || !clientId) return null;
  const clientSecret = typeof o["clientSecret"] === "string" ? o["clientSecret"] : undefined;
  const scopes = typeof o["scopes"] === "string" && o["scopes"] ? o["scopes"] : undefined;
  return {
    refreshToken,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

async function loadToken(): Promise<TokenCache | null> {
  try {
    const t = JSON.parse(await readFile(TOKEN_CACHE, "utf-8")) as TokenCache;
    return typeof t?.accessToken === "string" && typeof t?.expiresAt === "number" ? t : null;
  } catch {
    return null;
  }
}

async function saveToken(t: TokenCache): Promise<void> {
  try {
    await mkdir(join(homedir(), ".cadence"), { recursive: true });
    await writeFile(TOKEN_CACHE, JSON.stringify(t), "utf-8");
  } catch {
    // best-effort; a failed cache just means we refresh again next prompt
  }
}

async function refreshAccessToken(creds: SpotifyCreds): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: creds.clientId, // in-body client_id covers PKCE/public apps
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (creds.clientSecret) {
      const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
      headers["Authorization"] = `Basic ${basic}`;
    }
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      debug("spotify", `token refresh failed: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    await saveToken({
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    });
    return data.access_token;
  } catch (e) {
    debug("spotify", `token refresh error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Exported for dj-run: DJ and the now-playing provider share one cached
// token (`~/.cadence/spotify-token.json`), so neither double-refreshes.
export async function getAccessToken(creds: SpotifyCreds): Promise<string | null> {
  const cached = await loadToken();
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.accessToken;
  return refreshAccessToken(creds);
}

interface CurrentlyPlaying {
  is_playing?: boolean;
  item?: { name?: string; artists?: { name?: string }[] };
}

export async function getSpotifyNowPlaying(
  providers: ProviderConfig
): Promise<NowPlaying | null> {
  const creds = readCreds(providers);
  if (!creds) return null;
  const token = await getAccessToken(creds);
  if (!token) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOWPLAYING_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (res.status === 204 || !res.ok) return null; // 204 = nothing playing
    const data = (await res.json()) as CurrentlyPlaying;
    if (data.is_playing === false) return null;
    const track = data.item?.name;
    const artist = data.item?.artists?.map((a) => a.name).filter(Boolean).join(", ");
    if (!track || !artist) return null;
    return { track, artist, player: "Spotify" };
  } catch (e) {
    debug("spotify", `now-playing error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
