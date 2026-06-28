import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DJ_EVENTS,
  classifyUri,
  hasDjScopes,
  isDjEvent,
  readDjCooldownMs,
  readDjMappings,
  type DjLast,
} from "./dj.js";
import { readProviders } from "./config.js";
import { readCreds } from "./providers/spotify.js";
import { connectSpotify, DJ_SCOPES } from "./spotify-auth.js";
import { runDj } from "./dj-run.js";

/* ─────────────────────────────────────────────────────────────────────────
 * `cadence dj` — the CLI surface for reverse-direction actuation.
 *
 * All consent lives here: linking with playback scopes (a PKCE re-run — the
 * read-only refresh token can't be upgraded, scopes bind at consent time)
 * and the explicit event→URI mappings without which the feature is inert.
 * Per the OAuth rule, the browser flow runs ONLY in this interactive CLI.
 * ───────────────────────────────────────────────────────────────────────── */

const CADENCE_DIR = join(homedir(), ".cadence");
const CONFIG_FILE = join(CADENCE_DIR, "config.json");
const DJ_STATE_FILE = join(CADENCE_DIR, "dj.json");
const TOKEN_CACHE = join(CADENCE_DIR, "spotify-token.json");

async function loadCfg(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveCfg(cfg: Record<string, unknown>): Promise<void> {
  await mkdir(CADENCE_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

function cfgDj(providers: Record<string, unknown>): Record<string, unknown> {
  return providers["dj"] && typeof providers["dj"] === "object"
    ? (providers["dj"] as Record<string, unknown>)
    : {};
}

function cfgMappings(dj: Record<string, unknown>): Record<string, unknown> {
  return dj["mappings"] && typeof dj["mappings"] === "object"
    ? (dj["mappings"] as Record<string, unknown>)
    : {};
}

const DJ_HELP = `  cadence dj — material work transitions steer your Spotify playback

  Events you can map (unmapped events never act):
    ship              you told cadence you're shipping (cadence report "...")
    conflict          the repo entered a merge/rebase conflict
    conflictResolved  the conflict cleared
    testsRed          the test suite started failing
    testsGreen        the tests pass again
    thrash            a streak of destructive git ops

  A track URI queues gently (after the current song); a playlist/album URI
  switches what's playing. DJ never starts audio — only steers music that's
  already playing. Playback control needs Spotify Premium.

    cadence dj                       status
    cadence dj setup                 link Spotify with playback control (browser)
    cadence dj map <event> <uri>     e.g. cadence dj map testsGreen spotify:track:…
    cadence dj unmap <event>
    cadence dj test <event>          run an event now, errors visible
    cadence dj off                   turn dj off (the Spotify link survives)`;

async function cmdDjStatus(): Promise<void> {
  const cfg = await loadCfg();
  const providers = readProviders(cfg);
  const creds = readCreds(providers);
  const mappings = readDjMappings(providers);

  console.log("\n  cadence dj — work transitions steer Spotify\n");
  if (!creds) {
    console.log("    spotify     not linked — run: cadence dj setup");
  } else if (!hasDjScopes(creds.scopes)) {
    console.log("    spotify     linked read-only — relink with playback control: cadence dj setup");
  } else {
    console.log("    spotify     linked with playback control ✓");
  }

  if (Object.keys(mappings).length === 0) {
    console.log("    mappings    none — dj is inert until you map an event:");
    console.log("                cadence dj map testsGreen spotify:track:<id>");
  } else {
    console.log(`    cooldown    ${Math.round(readDjCooldownMs(providers) / 60_000)}m between actions`);
    console.log("    mappings");
    for (const event of DJ_EVENTS) {
      const uri = mappings[event];
      if (uri) {
        const kind = classifyUri(uri) === "queue" ? "queue " : "switch";
        console.log(`      ${event.padEnd(17)} ${kind}  ${uri}`);
      }
    }
  }

  try {
    const last = JSON.parse(await readFile(DJ_STATE_FILE, "utf-8")) as DjLast;
    if (last.lastActedAt && last.lastEvent) {
      const min = Math.round((Date.now() - last.lastActedAt) / 60_000);
      console.log(`    last        ${last.lastEvent} → ${last.lastUri ?? "?"} (${min}m ago)`);
    }
  } catch {
    // no actions yet
  }
  console.log("\n  events & help: cadence dj help\n");
}

async function cmdDjSetup(clientIdArg: string | undefined): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log("  cadence dj setup is interactive — run it in a terminal.");
    return;
  }
  const cfg = await loadCfg();
  const providers = readProviders(cfg);
  const existing = readCreds(providers);
  const clientId = clientIdArg || existing?.clientId || process.env["CADENCE_SPOTIFY_CLIENT_ID"];
  if (!clientId) {
    console.log("  cadence dj setup needs a Spotify app client id (cadence dj setup <clientId>).");
    console.log("  Create one at https://developer.spotify.com/dashboard — see: cadence spotify");
    return;
  }

  console.log("  DJ needs playback control, which means re-authorizing Spotify with");
  console.log("  broader scopes (read + modify playback). Playback control requires");
  console.log("  Spotify Premium — free accounts get a silent 403.\n");
  let refreshToken: string;
  try {
    refreshToken = await connectSpotify(clientId, (m) => console.log(m), DJ_SCOPES);
  } catch (e) {
    console.error(`  couldn't link Spotify: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  providers["spotify"] = { clientId, refreshToken, scopes: DJ_SCOPES.join(" ") };
  cfg["providers"] = providers;
  await saveCfg(cfg);
  // a cached read-only access token would 403 playback calls until it expires
  await rm(TOKEN_CACHE, { force: true }).catch(() => {});
  console.log("  ✓ Spotify linked with playback control\n");

  // mapping prompts — every one skippable, like `cadence start`
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("  Map events to music. Track URI = queued gently; playlist/album = switch.");
    console.log(`  events: ${DJ_EVENTS.join(", ")}`);
    for (;;) {
      const ans = (
        await rl.question('  map (e.g. "testsGreen spotify:track:…", enter to finish) > ')
      ).trim();
      if (!ans) break;
      const [event, uri] = ans.split(/\s+/);
      await cmdDjMap([event ?? "", uri ?? ""]);
    }
  } finally {
    rl.close();
  }
  console.log("\n  done — preview anytime: cadence dj\n");
}

async function cmdDjMap(args: string[]): Promise<void> {
  const [event, uri] = args;
  if (!event || !uri) {
    console.log("  usage: cadence dj map <event> <spotify-uri>");
    console.log(`  events: ${DJ_EVENTS.join(", ")}`);
    return;
  }
  if (!isDjEvent(event)) {
    console.error(`  unknown event "${event}" — events: ${DJ_EVENTS.join(", ")}`);
    return;
  }
  const kind = classifyUri(uri);
  if (!kind) {
    console.error("  that's not a spotify:track:/spotify:playlist:/spotify:album: URI");
    console.error("  (in Spotify: right-click → Share → Copy Spotify URI)");
    return;
  }
  const cfg = await loadCfg();
  const providers = readProviders(cfg);
  const dj = cfgDj(providers);
  const mappings = cfgMappings(dj);
  mappings[event] = uri;
  dj["mappings"] = mappings;
  providers["dj"] = dj;
  cfg["providers"] = providers;
  await saveCfg(cfg);
  console.log(
    `  mapped ${event} → ${uri} (${kind === "queue" ? "queues after the current song" : "switches playback"})`
  );
}

async function cmdDjUnmap(args: string[]): Promise<void> {
  const [event] = args;
  if (!event) {
    console.log("  usage: cadence dj unmap <event>");
    return;
  }
  const cfg = await loadCfg();
  const providers = readProviders(cfg);
  const dj = cfgDj(providers);
  const mappings = cfgMappings(dj);
  delete mappings[event];
  dj["mappings"] = mappings;
  providers["dj"] = dj;
  cfg["providers"] = providers;
  await saveCfg(cfg);
  console.log(`  unmapped ${event}`);
}

export async function cmdDj(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return cmdDjStatus();
    case "setup":
      return cmdDjSetup(rest[0]);
    case "map":
      return cmdDjMap(rest);
    case "unmap":
      return cmdDjUnmap(rest);
    case "test": {
      // in-process with a printing logger — the one place dj failures are
      // visible; the detached hook-spawned path logs only via CADENCE_DEBUG
      const event = rest[0] ?? "";
      console.log(`  dj test: ${event || "(no event)"}`);
      await runDj(event, (m) => console.log(`    ${m}`));
      return;
    }
    case "off": {
      const cfg = await loadCfg();
      const providers = readProviders(cfg);
      delete providers["dj"];
      cfg["providers"] = providers;
      await saveCfg(cfg);
      console.log("  dj off — mappings removed (the Spotify link survives)");
      return;
    }
    case "help":
    default:
      console.log(DJ_HELP);
  }
}
