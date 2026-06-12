#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  decideDjAction,
  hasDjScopes,
  isDjEvent,
  readDjCooldownMs,
  readDjMappings,
  type DjLast,
  type PlayerState,
} from "./dj.js";
import { isPaused, loadProviders } from "./config.js";
import { getAccessToken, readCreds } from "./providers/spotify.js";
import { debug } from "./debug.js";

/* ─────────────────────────────────────────────────────────────────────────
 * dj-run — the detached actuator: `node dist/dj-run.js <event>`.
 *
 * This is the ONLY place Cadence touches Spotify playback. Hooks spawn it
 * detached/unref'd and never wait; the CLI (`cadence dj test <event>`) runs
 * runDj() in-process with a printing logger — the one place failures are
 * visible, the debugging escape hatch for this otherwise fail-silent path.
 *
 * Not referenced by hooks/hooks.json — it is never a hook, only a child.
 * Every Spotify error (403 Premium-required, 429, timeout, refresh failure)
 * logs via debug() and exits 0: a broken DJ is a quiet DJ.
 * ───────────────────────────────────────────────────────────────────────── */

const STATE_FILE = join(homedir(), ".cadence", "dj.json");
const SPOTIFY_TIMEOUT_MS = 1500;
const HARD_EXIT_MS = 6000; // belt and suspenders: never linger past the moment

async function loadDjState(): Promise<DjLast> {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf-8")) as DjLast;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function saveDjState(state: DjLast): Promise<void> {
  try {
    await mkdir(join(homedir(), ".cadence"), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state), "utf-8");
  } catch {
    // best-effort; a failed save just means a shorter effective cooldown
  }
}

async function spotifyFetch(
  token: string,
  path: string,
  init: { method?: string; body?: string } = {}
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SPOTIFY_TIMEOUT_MS);
  try {
    return await fetch(`https://api.spotify.com/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Shape /v1/me/player's response into the pure decision's input. Pure. */
export function playerStateFrom(json: unknown): PlayerState {
  const data = json as {
    is_playing?: boolean;
    context?: { uri?: string };
    item?: { uri?: string };
  };
  return {
    isPlaying: data?.is_playing === true,
    ...(typeof data?.context?.uri === "string" ? { contextUri: data.context.uri } : {}),
    ...(typeof data?.item?.uri === "string" ? { trackUri: data.item.uri } : {}),
  };
}

async function fetchPlayerState(token: string): Promise<PlayerState | null> {
  const res = await spotifyFetch(token, "/me/player");
  if (!res || res.status === 204 || !res.ok) return null; // 204 = no active device
  try {
    return playerStateFrom(await res.json());
  } catch {
    return null;
  }
}

/** Run one DJ event end-to-end. The logger is debug() when detached and
 * console.log when run via `cadence dj test` — same path, different ears. */
export async function runDj(event: string, log: (msg: string) => void = () => {}): Promise<void> {
  if (!isDjEvent(event)) {
    log(`unknown event "${event}" — events: ship, conflict, conflictResolved, testsRed, testsGreen, thrash`);
    return;
  }
  if (await isPaused()) {
    log("cadence is paused — dj stays quiet");
    return;
  }
  const providers = await loadProviders();
  const mappings = readDjMappings(providers);
  if (Object.keys(mappings).length === 0) {
    log("dj is off — no mappings. map one: cadence dj map <event> <spotify-uri>");
    return;
  }
  const creds = readCreds(providers);
  if (!creds) {
    log("Spotify isn't linked — run: cadence dj setup");
    return;
  }
  if (!hasDjScopes(creds.scopes)) {
    log("Spotify is linked read-only — relink with playback control: cadence dj setup");
    return;
  }
  const token = await getAccessToken(creds);
  if (!token) {
    log("couldn't get a Spotify access token (try: cadence dj setup)");
    return;
  }

  const [player, last] = await Promise.all([fetchPlayerState(token), loadDjState()]);
  const action = decideDjAction({
    event,
    mappings,
    player,
    last,
    now: Date.now(),
    cooldownMs: readDjCooldownMs(providers),
  });
  if (!action.act) {
    const why: Record<string, string> = {
      unmapped: `no mapping for "${event}"`,
      "nothing-playing": "nothing is playing — dj never starts audio, only steers it",
      cooldown: "within the cooldown window",
      "already-playing": "that music is already playing",
    };
    log(`skipped: ${why[action.reason] ?? action.reason}`);
    return;
  }

  const res =
    action.kind === "queue"
      ? await spotifyFetch(token, `/me/player/queue?uri=${encodeURIComponent(action.uri)}`, {
          method: "POST",
        })
      : await spotifyFetch(token, "/me/player/play", {
          method: "PUT",
          body: JSON.stringify({ context_uri: action.uri }),
        });
  if (!res) {
    log("Spotify didn't answer in time");
    return;
  }
  if (!res.ok) {
    log(
      res.status === 403
        ? "Spotify returned 403 — playback control needs Spotify Premium"
        : `Spotify returned ${res.status}`
    );
    return;
  }

  await saveDjState({ lastEvent: event, lastActedAt: Date.now(), lastUri: action.uri });
  log(`${event}: ${action.kind === "queue" ? "queued" : "switched to"} ${action.uri}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  runDj(process.argv[2] ?? "", (m) => debug("dj", m))
    .catch((err: unknown) => {
      debug("dj", err instanceof Error ? err.message : String(err));
    })
    .finally(() => process.exit(0));
}
