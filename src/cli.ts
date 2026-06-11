#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getAmbientSignal } from "./providers/ambient.js";
import { getGitSignal } from "./providers/git.js";
import { getEsotericSignal } from "./providers/esoteric.js";
import {
  deriveCadence,
  buildReframe,
  loadOverrides,
  applyOverrides,
  resolveDialLevel,
  DIALS,
  DIAL_WORDS,
} from "./cadence.js";
import { render } from "./inject.js";
import { renderSignalsTable } from "./signals-view.js";
import { loadProviders, providerEnabled, isPaused, OPT_IN_PROVIDERS } from "./config.js";
import { connectSpotify, REDIRECT_URI } from "./spotify-auth.js";
import type { Signal, UserState, Cadence, DialLevel } from "./types.js";

const CADENCE_DIR = join(homedir(), ".cadence");
const STATE_FILE = join(CADENCE_DIR, "state.txt");
const CONFIG_FILE = join(CADENCE_DIR, "config.json");

async function cmdState(args: string[]) {
  if (args.length === 0) {
    try {
      const text = (await readFile(STATE_FILE, "utf-8")).trim();
      console.log(text || "(no state set)");
    } catch {
      console.log("(no state set)");
    }
    return;
  }
  const text = args.join(" ");
  await mkdir(CADENCE_DIR, { recursive: true });
  await writeFile(STATE_FILE, text, "utf-8");
  console.log(`  state set: "${text}"`);
}

async function cmdClear() {
  await mkdir(CADENCE_DIR, { recursive: true });
  await writeFile(STATE_FILE, "", "utf-8");
  console.log("  state cleared");
}

// Collects live signals and renders the exact block the hook would inject,
// or null when there's nothing to say. Shared by `test` and the bare command.
async function buildPreview(): Promise<string | null> {
  const signals: Signal[] = [];
  const providers = await loadProviders();
  const [music, report, ambient, git, esoteric, overrides] = await Promise.all([
    getMusicSignal(providers).catch(() => null),
    getSelfReportSignal().catch(() => null),
    getAmbientSignal(new Date(), {
      focusedAppEnabled: providerEnabled(providers, "focusedApp"),
    }).catch(() => null),
    getGitSignal(process.cwd()).catch(() => null),
    getEsotericSignal(providers).catch(() => null),
    loadOverrides(),
  ]);
  if (music) signals.push(music);
  if (report) signals.push(report);
  if (ambient) signals.push(ambient);
  if (git) signals.push(git);
  if (esoteric) signals.push(esoteric);

  if (signals.length === 0 && Object.keys(overrides).length === 0) return null;

  const state: UserState = { signals, capturedAt: Date.now() };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const reframe = buildReframe(cadence);
  return render({ ...state, cadence, pinned, reframe });
}

async function cmdTest() {
  const block = await buildPreview();
  if (!block) {
    console.log('  (no signals — play something, set: cadence state "...", or pin a dial: cadence set pace fast)');
    return;
  }
  console.log("\n" + block + "\n");
}

// The legibility view: every signal Cadence can read — live value, or the
// reason it's absent. Unlike `test`, this never goes silent.
async function cmdSignals() {
  const [music, report, ambient, git, providers] = await Promise.all([
    getMusicSignal().catch(() => null),
    getSelfReportSignal().catch(() => null),
    getAmbientSignal(new Date()).catch(() => null),
    getGitSignal(process.cwd()).catch(() => null),
    loadProviders(),
  ]);
  console.log(
    "\n" +
      renderSignalsTable({
        music,
        report,
        ambient,
        git,
        providers,
        now: Date.now(),
        platform: process.platform,
      }) +
      "\n"
  );
}

// ── opt-in provider registry: the consent layer ────────────────────────────
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

function cfgProviders(cfg: Record<string, unknown>): Record<string, unknown> {
  return cfg["providers"] && typeof cfg["providers"] === "object"
    ? (cfg["providers"] as Record<string, unknown>)
    : {};
}

function knownProvider(name: string | undefined): name is keyof typeof OPT_IN_PROVIDERS {
  return name != null && name in OPT_IN_PROVIDERS;
}

function listProviders() {
  console.log("  opt-in signals (off until you enable them):");
  for (const [name, desc] of Object.entries(OPT_IN_PROVIDERS)) {
    console.log(`    ${name.padEnd(14)} ${desc}`);
  }
}

async function cmdEnable(args: string[]) {
  const [name, ...valueParts] = args;
  if (!name) {
    console.log("  usage: cadence enable <signal> [value]   e.g. cadence enable typingTempo");
    listProviders();
    return;
  }
  if (!knownProvider(name)) {
    console.error(`  unknown signal "${name}".`);
    if (name === "spotify") console.error("  spotify takes credentials — run: cadence spotify");
    listProviders();
    process.exit(1);
  }
  const cfg = await loadCfg();
  const providers = cfgProviders(cfg);
  providers[name] = valueParts.length ? valueParts.join(" ") : true;
  cfg["providers"] = providers;
  await saveCfg(cfg);
  console.log(`  enabled ${name}${valueParts.length ? ` = "${valueParts.join(" ")}"` : ""}`);
}

// The whole-product kill switch. State (pins, opt-ins, self-report) survives a
// pause untouched — resume picks up exactly where you left off.
async function cmdPause() {
  const cfg = await loadCfg();
  cfg["paused"] = true;
  await saveCfg(cfg);
  console.log("  cadence paused — prompts go through untouched. resume: cadence resume");
}

async function cmdResume() {
  const cfg = await loadCfg();
  delete cfg["paused"];
  await saveCfg(cfg);
  console.log("  cadence resumed — reading the room again. preview: cadence test");
}

async function cmdDisable(args: string[]) {
  const [name] = args;
  if (!name) {
    console.log("  usage: cadence disable <signal>");
    listProviders();
    return;
  }
  const cfg = await loadCfg();
  const providers = cfgProviders(cfg);
  delete providers[name];
  cfg["providers"] = providers;
  await saveCfg(cfg);
  console.log(`  disabled ${name}`);
}

// Spotify is the cross-platform music source — opt-in, browser-authorized via
// PKCE (no client secret to keep). Bring your own Spotify app client id (or
// bake one in below / via env for a zero-config experience).
const DEFAULT_SPOTIFY_CLIENT_ID = ""; // register a "Cadence" app and set this to ship zero-config

const SPOTIFY_HELP = `  cadence spotify — link Spotify as a cross-platform now-playing source

  macOS already reads Spotify.app / Music.app with zero setup. This is for
  Linux / Windows (or anyone not scripting the desktop app).

  One-time setup, then we handle the token dance for you:
    1. Create an app at https://developer.spotify.com/dashboard
    2. Add this redirect URI to it: ${REDIRECT_URI}
    3. cadence spotify connect <clientId>   (opens your browser once)

  Then it's just another music signal — vibe still comes from MusicBrainz.
  Advanced (skip the browser): cadence spotify <clientId> <refreshToken>
  Turn it off: cadence spotify off`;

async function cmdSpotifyConnect(clientIdArg: string | undefined) {
  const clientId =
    clientIdArg || process.env["CADENCE_SPOTIFY_CLIENT_ID"] || DEFAULT_SPOTIFY_CLIENT_ID;
  if (!clientId) {
    console.log("  cadence spotify connect needs a Spotify app client id.\n");
    console.log(SPOTIFY_HELP);
    return;
  }
  if (!process.stdin.isTTY) {
    console.log("  spotify connect is interactive — run it in a terminal.");
    return;
  }
  try {
    const refreshToken = await connectSpotify(clientId, (m) => console.log(m));
    const cfg = await loadCfg();
    const providers = cfgProviders(cfg);
    providers["spotify"] = { clientId, refreshToken };
    cfg["providers"] = providers;
    await saveCfg(cfg);
    console.log("  ✓ Spotify linked — currently-playing is now a cross-platform signal");
  } catch (e) {
    console.error(`  couldn't link Spotify: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function cmdSpotify(args: string[]) {
  const [first, second, third] = args;
  if (first === "connect") return cmdSpotifyConnect(second);
  if (first === "off") {
    const cfg = await loadCfg();
    const providers = cfgProviders(cfg);
    delete providers["spotify"];
    cfg["providers"] = providers;
    await saveCfg(cfg);
    console.log("  unlinked Spotify");
    return;
  }
  // advanced manual path: clientId + refreshToken (+ optional secret)
  if (first && second) {
    const cfg = await loadCfg();
    const providers = cfgProviders(cfg);
    providers["spotify"] = third
      ? { clientId: first, refreshToken: second, clientSecret: third }
      : { clientId: first, refreshToken: second };
    cfg["providers"] = providers;
    await saveCfg(cfg);
    console.log("  Spotify linked — currently-playing is now a cross-platform signal");
    return;
  }
  console.log(SPOTIFY_HELP);
}

const LEVELS: DialLevel[] = ["low", "medium", "high"];

async function cmdSet(args: string[]) {
  const [dial, value] = args;
  if (!dial || !value) {
    console.log("  usage: cadence set <dial> <value>   e.g. cadence set pace fast");
    console.log(`  dials: ${DIALS.join(", ")}`);
    return;
  }
  if (!(DIALS as readonly string[]).includes(dial)) {
    console.error(`  unknown dial "${dial}" — choose from: ${DIALS.join(", ")}`);
    process.exit(1);
  }
  const d = dial as keyof Cadence;
  const level = resolveDialLevel(d, value);
  if (!level) {
    const words = LEVELS.map((l) => DIAL_WORDS[d][l]).join(" | ");
    console.error(`  "${value}" isn't valid for ${dial}. Use: ${words}  (or low|medium|high)`);
    process.exit(1);
  }
  await mkdir(CADENCE_DIR, { recursive: true });
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
  } catch {
    // no config yet
  }
  cfg[dial] = level;
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  console.log(`  pinned ${dial} = ${DIAL_WORDS[d][level]} (${level})`);
}

async function cmdUnset(args: string[]) {
  const [dial] = args;
  await mkdir(CADENCE_DIR, { recursive: true });
  let cfg: Record<string, string> = {};
  try {
    cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
  } catch {
    // none
  }
  if (!dial || dial === "all") {
    await writeFile(CONFIG_FILE, "{}", "utf-8");
    console.log("  unpinned all dials — back to fully inferred");
    return;
  }
  delete cfg[dial];
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  console.log(`  unpinned ${dial} — back to inferred`);
}

async function cmdDials() {
  const overrides = await loadOverrides();
  console.log("\n  cadence dials (* = pinned by you):\n");
  for (const dial of DIALS) {
    const pinnedLevel = overrides[dial];
    const opts = LEVELS.map((l) => {
      const word = DIAL_WORDS[dial][l as DialLevel];
      return l === pinnedLevel ? `[${word}]*` : word;
    }).join("  ");
    console.log(`    ${dial.padEnd(12)} ${opts}`);
  }
  console.log("\n  pin one:  cadence set <dial> <low|medium|high>");
  console.log("  unpin:    cadence unset <dial>   (or: cadence unset all)\n");
}

// Weather is opt-in: it only activates once a location is configured. No
// silent geolocation — the user provides coordinates explicitly.
async function cmdLocation(args: string[]) {
  const [lat, lon, ...nameParts] = args;
  if (!lat || !lon) {
    console.log("  usage: cadence set-location <lat> <lon> [name]");
    console.log("  e.g.   cadence set-location 40.71 -74.01 NYC");
    console.log("  (find yours at https://www.latlong.net — weather stays off until set)");
    return;
  }
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    console.error("  lat and lon must be numbers");
    process.exit(1);
  }
  await mkdir(CADENCE_DIR, { recursive: true });
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
  } catch {
    // none
  }
  cfg["location"] = { lat: latNum, lon: lonNum, name: nameParts.join(" ") || undefined };
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  console.log(`  location set${nameParts.length ? ` (${nameParts.join(" ")})` : ""} — weather is now on`);
}

// Has the user ever told Cadence anything? (Signals like time-of-day always
// exist, so "fresh install" is detected by absence of user INPUT, not signals.)
async function hasUserInput(): Promise<boolean> {
  const [state, config] = await Promise.all([
    readFile(STATE_FILE, "utf-8").catch(() => ""),
    readFile(CONFIG_FILE, "utf-8").catch(() => "{}"),
  ]);
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(config) as Record<string, unknown>;
  } catch {
    // unreadable config = no input
  }
  return state.trim().length > 0 || Object.keys(cfg).length > 0;
}

const INPUTS_FOOTER = `  where you can input:
    cadence state "..."              how you are right now (2h TTL)
    cadence set <dial> <level>       pin a dial: ${DIALS.join(", ")}
    cadence set-location <lat> <lon> opt into weather
    cadence start                    interactive setup
    cadence help                     everything else`;

// Bare \`cadence\`: live status + where to input — not a help dump.
async function cmdRoot() {
  if (await isPaused()) {
    console.log("\n  cadence is paused — prompts go through untouched.");
    console.log("  resume: cadence resume\n");
    return;
  }
  if (!(await hasUserInput())) {
    console.log("\n  cadence — agents that read the room");
    console.log("  It hasn't heard from you yet. Fastest start:\n");
    console.log('    cadence start              guided setup (~30s)');
    console.log('    cadence state "ship mode"  or just say how you are\n');
    return;
  }
  const block = await buildPreview();
  if (block) {
    console.log("\n" + block + "\n");
  } else {
    console.log("\n  (no signals right now)\n");
  }
  console.log(INPUTS_FOOTER + "\n");
}

// Guided first run: three prompts, every one skippable, nothing destructive.
async function cmdStart() {
  if (!process.stdin.isTTY) {
    console.log('  cadence start is interactive — run it in a terminal, or use: cadence state "..."');
    return;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n  cadence — agents that read the room");
    console.log("  Three questions. Enter skips any of them; everything can be changed later.\n");

    // 1 ── self-reported state: the highest-leverage input
    const state = (await rl.question('  1/3  How are you right now? (e.g. "two beers, ship mode")\n       > ')).trim();
    if (state) {
      await mkdir(CADENCE_DIR, { recursive: true });
      await writeFile(STATE_FILE, state, "utf-8");
      console.log('       ✓ set — expires after 2h; update anytime: cadence state "..."\n');
    } else {
      console.log('       skipped — later: cadence state "..."\n');
    }

    // 2 ── dial pins: overrides, so only offered, never pushed
    console.log(`  2/3  Pin any dials? Pins override inference until unset.`);
    console.log(`       dials: ${DIALS.join(", ")} — levels: low|medium|high`);
    for (;;) {
      const ans = (await rl.question('       pin (e.g. "pace high", enter to continue) > ')).trim();
      if (!ans) break;
      const [dial, value] = ans.split(/\s+/);
      if (!dial || !value || !(DIALS as readonly string[]).includes(dial)) {
        console.log(`       format: <dial> <level>, dials: ${DIALS.join(", ")}`);
        continue;
      }
      const d = dial as keyof Cadence;
      const level = resolveDialLevel(d, value);
      if (!level) {
        console.log(`       "${value}" isn't valid for ${dial} — use low|medium|high`);
        continue;
      }
      await cmdSet([dial, value]);
    }
    console.log();

    // 3 ── weather: explicitly opt-in, mirrors cmdLocation's no-silent-geo rule
    const loc = (await rl.question("  3/3  Weather? Give a location, or enter to leave it off.\n       lat lon [name] (e.g. 40.71 -74.01 NYC) > ")).trim();
    if (loc) {
      await cmdLocation(loc.split(/\s+/));
    } else {
      console.log("       skipped — weather stays off until: cadence set-location <lat> <lon>");
    }

    console.log("\n  Done. Here's exactly what the hook injects right now:");
    await cmdTest();
  } catch {
    // Ctrl+D / Ctrl+C mid-wizard: every step saves as it goes, so an early
    // exit just means "stop asking" — never an error, never a rollback.
    console.log("\n  setup ended early — anything you answered is saved\n");
  } finally {
    rl.close();
  }
}

const HELP = `
  cadence — agents that read the room

  daily:
    cadence                     live status + where to input
    cadence start               guided setup (state, dials, weather — all skippable)
    cadence state "..."         set self-reported state (e.g. "two beers, ship mode")
    cadence state               print current self-reported state
    cadence clear               clear self-reported state
    cadence test                preview what the hook would inject right now
    cadence signals             every signal — live value, or why it's absent
    cadence pause               silence all hooks (state survives untouched)
    cadence resume              start reading the room again

  dials (your determination — pinned dials override inference):
    cadence dials               show the mixing board and what's pinned
    cadence set <dial> <level>  pin a dial (level: low|medium|high)
    cadence unset <dial>        un-pin a dial (or: cadence unset all)
                                dials: pace, tone, posture, proactivity
                                (env also works: CADENCE_PACE=fast)

  ambient (time & day are automatic; weather is opt-in):
    cadence set-location <lat> <lon> [name]   turn on weather for your area

  opt-in signals (off until you turn them on — as much as you're willing to give):
    cadence enable <signal> [value]   turn an opt-in signal on (e.g. typingTempo)
    cadence disable <signal>          turn it back off
                                      see them all: cadence signals

  music (macOS reads Spotify.app / Music.app automatically):
    cadence spotify connect <id>      link Spotify (cross-platform, opens browser)
    cadence spotify off               unlink it
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return cmdStart();
    case "state":
      return cmdState(rest);
    case "clear":
      return cmdClear();
    case "test":
      return cmdTest();
    case "signals":
      return cmdSignals();
    case "set":
      return cmdSet(rest);
    case "unset":
      return cmdUnset(rest);
    case "dials":
      return cmdDials();
    case "set-location":
      return cmdLocation(rest);
    case "pause":
      return cmdPause();
    case "resume":
      return cmdResume();
    case "enable":
      return cmdEnable(rest);
    case "disable":
      return cmdDisable(rest);
    case "spotify":
      return cmdSpotify(rest);
    case undefined:
      return cmdRoot(); // live status + inputs, not the help dump
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
});
