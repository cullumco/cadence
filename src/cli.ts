#!/usr/bin/env node
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal, STALE_AFTER_MS } from "./providers/selfreport.js";
import { getEnvironmentSignal } from "./providers/environment.js";
import { getGitSignal } from "./providers/git.js";
import { getEsotericSignal } from "./providers/esoteric.js";
import {
  deriveCadence,
  buildReframe,
  loadOverrides,
  loadOverridesDetailed,
  applyOverrides,
  resolveDialLevel,
  DIALS,
  DIAL_WORDS,
} from "./cadence.js";
import { render } from "./inject.js";
import { renderSignalsTable, type RawSignals } from "./signals-view.js";
import { runInstrument } from "./tui.js";
import { loadProviders, providerEnabled, isPaused, OPT_IN_PROVIDERS } from "./config.js";
import { readTuneLog, renderTuneReport, tuneLogPath } from "./learn.js";
import { connectSpotify, REDIRECT_URI } from "./spotify-auth.js";
import { SHIP_PATTERN, maybeSpawnDj } from "./dj.js";
import { cmdDj } from "./dj-cli.js";
import { cmdEnvelope } from "./envelope-cli.js";
import type {
  Signal,
  UserState,
  StateWithCadence,
  EsotericSignal,
  Cadence,
  DialLevel,
} from "./types.js";

const CADENCE_DIR = join(homedir(), ".cadence");
const STATE_FILE = join(CADENCE_DIR, "state.txt");
const CONFIG_FILE = join(CADENCE_DIR, "config.json");

async function cmdReport(args: string[]) {
  if (args.length === 0) {
    // Same TTL the hook applies — printing an expired report as if it were
    // live would contradict what actually gets injected.
    const report = await getSelfReportSignal();
    if (report) {
      const rem = Math.max(0, STALE_AFTER_MS - (Date.now() - report.setAt));
      const h = Math.floor(rem / 3_600_000);
      const m = Math.floor((rem % 3_600_000) / 60_000);
      console.log(`${report.text}  (${h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`} left)`);
      return;
    }
    try {
      const stale = (await readFile(STATE_FILE, "utf-8")).trim();
      console.log(
        stale
          ? `(last self-report expired — refresh: cadence report "...")`
          : "(no self-report set)"
      );
    } catch {
      console.log("(no self-report set)");
    }
    return;
  }
  const text = args.join(" ");
  await mkdir(CADENCE_DIR, { recursive: true });
  await writeFile(STATE_FILE, text, "utf-8");
  console.log(`  self-report set: "${text}"`);
  // DJ ship trigger — only from this explicit report path (the prompt-intent
  // trigger is deliberately deferred, see src/dj.ts); no-op unless mapped.
  if (SHIP_PATTERN.test(text)) await maybeSpawnDj("ship");
}

async function cmdClear() {
  await mkdir(CADENCE_DIR, { recursive: true });
  await writeFile(STATE_FILE, "", "utf-8");
  console.log("  self-report cleared");
}

// One provider sweep → the structured envelope shared by `test`, the static
// bare command, and the live instrument. `state` is null when the hook would
// stay silent; `raw`/dials are always populated so the board never goes blank.
interface Envelope {
  state: StateWithCadence | null;
  raw: RawSignals;
  esoteric: EsotericSignal | null;
  cadence: Cadence;
  pinned: (keyof Cadence)[];
  reframe: string;
  paused: boolean;
}

async function collectEnvelope(now = Date.now()): Promise<Envelope> {
  const signals: Signal[] = [];
  const providers = await loadProviders();
  const [music, report, environment, git, esoteric, overrides, paused] = await Promise.all([
    getMusicSignal(providers).catch(() => null),
    getSelfReportSignal().catch(() => null),
    getEnvironmentSignal(new Date(now), {
      focusedAppEnabled: providerEnabled(providers, "focusedApp"),
      wifiEnabled: providerEnabled(providers, "wifi"),
    }).catch(() => null),
    getGitSignal(process.cwd()).catch(() => null),
    getEsotericSignal(providers).catch(() => null),
    loadOverrides(process.cwd()), // project pins apply where you're standing
    isPaused(),
  ]);
  if (music) signals.push(music);
  if (report) signals.push(report);
  if (environment) signals.push(environment);
  if (git) signals.push(git);
  if (esoteric) signals.push(esoteric);

  const state: UserState = { signals, capturedAt: now };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const reframe = buildReframe(cadence);
  const silent = signals.length === 0 && Object.keys(overrides).length === 0;
  return {
    state: silent ? null : { ...state, cadence, pinned, reframe },
    raw: { music, report, environment, git, providers, now, platform: process.platform },
    esoteric,
    cadence,
    pinned,
    reframe,
    paused,
  };
}

// Renders the exact block the hook would inject, or null when there's
// nothing to say. Shared by `test` and the static bare command.
async function buildPreview(): Promise<string | null> {
  const e = await collectEnvelope();
  return e.state ? render(e.state) : null;
}

async function cmdTest() {
  const block = await buildPreview();
  if (!block) {
    console.log('  (no signals — play something, set: cadence report "...", or pin a dial: cadence set pace fast)');
    return;
  }
  console.log("\n" + block + "\n");
}

// The legibility view: every signal Cadence can read — live value, or the
// reason it's absent. Unlike `test`, this never goes silent.
async function cmdSignals() {
  const providers = await loadProviders();
  const [music, report, environment, git] = await Promise.all([
    getMusicSignal().catch(() => null),
    getSelfReportSignal().catch(() => null),
    getEnvironmentSignal(new Date(), {
      focusedAppEnabled: providerEnabled(providers, "focusedApp"),
      wifiEnabled: providerEnabled(providers, "wifi"),
    }).catch(() => null),
    getGitSignal(process.cwd()).catch(() => null),
  ]);
  console.log(
    "\n" +
      renderSignalsTable({
        music,
        report,
        environment,
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
    if (name === "dj") console.error("  dj takes setup — run: cadence dj setup");
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

// The learning-loop readout: where your next words pulled against the lens.
// Report-only by design — it never re-weights nudges or edits config; the one
// action it points at is the existing user-authority path (pin a dial).
async function cmdTune(args: string[]) {
  if (args[0] === "clear") {
    await rm(tuneLogPath(), { force: true });
    console.log("  tune log cleared");
    return;
  }
  const entries = await readTuneLog();
  if (entries.length === 0) {
    const providers = await loadProviders();
    if (!providerEnabled(providers, "tuning")) {
      console.log("  tuning is off — turn it on: cadence enable tuning");
      console.log("  (logs derived prompt features only — length/intent/cue classes, never text)");
    } else {
      console.log("  no entries yet — the log fills as you prompt with tuning enabled");
    }
    return;
  }
  console.log("\n" + renderTuneReport(entries) + "\n");
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

/* Project pins live in the user's config under `projects` — absolute
 * directory path → partial pins. User config ONLY, never a repo-committed
 * file (see resolveProjectPins in cadence.ts for the security rationale). */
function cfgProjects(cfg: Record<string, unknown>): Record<string, unknown> {
  return cfg["projects"] && typeof cfg["projects"] === "object" && !Array.isArray(cfg["projects"])
    ? (cfg["projects"] as Record<string, unknown>)
    : {};
}

// `--project` scopes a pin/unpin to the current directory. Pull the flag out
// wherever it appears so `cadence set --project pace fast` also works.
function splitProjectFlag(args: string[]): { rest: string[]; project: boolean } {
  return { rest: args.filter((a) => a !== "--project"), project: args.includes("--project") };
}

async function cmdSet(args: string[]) {
  const { rest, project } = splitProjectFlag(args);
  const [dial, value] = rest;
  if (!dial || !value) {
    console.log("  usage: cadence set <dial> <value> [--project]   e.g. cadence set pace fast");
    console.log(`  dials: ${DIALS.join(", ")}   (--project pins it for this directory only)`);
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
  const cfg = await loadCfg();
  if (project) {
    const dir = process.cwd();
    const projects = cfgProjects(cfg);
    const pins =
      projects[dir] && typeof projects[dir] === "object" && !Array.isArray(projects[dir])
        ? (projects[dir] as Record<string, unknown>)
        : {};
    pins[dial] = level;
    projects[dir] = pins;
    cfg["projects"] = projects;
    await saveCfg(cfg);
    console.log(`  pinned ${dial} = ${DIAL_WORDS[d][level]} (${level}) for ${dir}`);
    console.log("  (applies in subdirectories too; deeper project pins win)");
    return;
  }
  cfg[dial] = level;
  await saveCfg(cfg);
  console.log(`  pinned ${dial} = ${DIAL_WORDS[d][level]} (${level})`);
}

async function cmdUnset(args: string[]) {
  const { rest, project } = splitProjectFlag(args);
  const [dial] = rest;
  const cfg = await loadCfg();
  if (project) {
    const dir = process.cwd();
    const projects = cfgProjects(cfg);
    const entry =
      projects[dir] && typeof projects[dir] === "object" && !Array.isArray(projects[dir])
        ? (projects[dir] as Record<string, unknown>)
        : null;
    if (!entry) {
      console.log(`  no project pins for ${dir}`);
      return;
    }
    if (!dial || dial === "all") {
      delete projects[dir];
      console.log(`  cleared project pins for ${dir}`);
    } else {
      delete entry[dial];
      if (Object.keys(entry).length === 0) delete projects[dir];
      console.log(`  unpinned ${dial} for ${dir}`);
    }
    cfg["projects"] = projects;
    await saveCfg(cfg);
    return;
  }
  if (!dial || dial === "all") {
    // only the dial pins — providers, location, and project pins survive
    for (const d of DIALS) delete cfg[d];
    await saveCfg(cfg);
    console.log("  unpinned all global dials — back to fully inferred");
    return;
  }
  delete cfg[dial];
  await saveCfg(cfg);
  console.log(`  unpinned ${dial} — back to inferred`);
}

// The legibility view for project pins: every directory with pins, and which
// one applies where you're standing. list / clear, mirroring cmdUnset's shape.
async function cmdProjects(args: string[]) {
  const cfg = await loadCfg();
  if (args[0] === "clear") {
    if (args[1] === "all") {
      delete cfg["projects"];
      await saveCfg(cfg);
      console.log("  cleared project pins for all directories");
      return;
    }
    const dir = process.cwd();
    const projects = cfgProjects(cfg);
    if (!projects[dir]) {
      console.log(`  no project pins for ${dir}   (all of them: cadence projects clear all)`);
      return;
    }
    delete projects[dir];
    cfg["projects"] = projects;
    await saveCfg(cfg);
    console.log(`  cleared project pins for ${dir}`);
    return;
  }
  const projects = cfgProjects(cfg);
  const dirs = Object.keys(projects).sort();
  if (dirs.length === 0) {
    console.log("  no project pins — set one: cadence set <dial> <level> --project");
    return;
  }
  const cwd = process.cwd();
  console.log("\n  project pins (deepest matching directory wins; env vars beat all pins):\n");
  for (const dir of dirs) {
    const raw = projects[dir];
    const pins: string[] = [];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const d of DIALS) {
        const level = resolveDialLevel(d, (raw as Record<string, unknown>)[d]);
        if (level) pins.push(`${d}=${DIAL_WORDS[d][level]}`);
      }
    }
    const here = cwd === dir || cwd.startsWith(dir.endsWith("/") ? dir : dir + "/");
    console.log(`    ${dir}${here ? "   ← applies here" : ""}`);
    console.log(`      ${pins.length ? pins.join("  ") : "(no valid pins)"}`);
  }
  console.log("\n  clear here: cadence projects clear   (everywhere: cadence projects clear all)\n");
}

async function cmdDials() {
  const { overrides, sources } = await loadOverridesDetailed(process.cwd());
  console.log("\n  cadence dials (* = pinned by you, from here):\n");
  for (const dial of DIALS) {
    const pinnedLevel = overrides[dial];
    const opts = LEVELS.map((l) => {
      const word = DIAL_WORDS[dial][l as DialLevel];
      return l === pinnedLevel ? `[${word}]*` : word;
    }).join("  ");
    // Label non-global pins so a project pin never masquerades as a global one.
    const src = sources[dial];
    const tag = src === "project" ? "   ← project pin" : src === "env" ? "   ← env var" : "";
    console.log(`    ${dial.padEnd(12)} ${opts}${tag}`);
  }
  console.log("\n  pin one:  cadence set <dial> <low|medium|high>   (--project: this directory only)");
  console.log("  unpin:    cadence unset <dial>   (or: cadence unset all)");
  console.log("  project pins: cadence projects\n");
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
    cadence report "..."              how you are right now (2h TTL)
    cadence set <dial> <level>       pin a dial: ${DIALS.join(", ")}
    cadence set-location <lat> <lon> opt into weather
    cadence start                    interactive setup
    cadence help                     everything else`;

// Bare \`cadence\`: the live instrument in a real terminal; the same static
// status everywhere else (pipes, CI, TERM=dumb, --plain) — not a help dump.
async function cmdRoot(rest: string[] = []) {
  if (await isPaused()) {
    console.log("\n  cadence is paused — prompts go through untouched.");
    console.log("  resume: cadence resume\n");
    return;
  }
  if (!(await hasUserInput())) {
    console.log("\n  cadence — agents that read the room");
    console.log("  It hasn't heard from you yet. Fastest start:\n");
    console.log('    cadence start              guided setup (~30s)');
    console.log('    cadence report "ship mode"  or just say how you are\n');
    return;
  }
  // The board needs a real terminal on BOTH ends — anything piped or dumb
  // keeps today's static output byte-for-byte.
  const interactive =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env["TERM"] !== "dumb" &&
    !rest.includes("--plain");
  if (interactive) {
    await runInstrument(async () => {
      const e = await collectEnvelope();
      return {
        cadence: e.cadence,
        pinned: e.pinned,
        reframe: e.reframe,
        raw: e.raw,
        esoteric: e.esoteric,
        now: e.raw.now,
        paused: e.paused,
      };
    });
    // Land back on the primary screen with the affordances visible.
    console.log("\n" + INPUTS_FOOTER + "\n");
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
    console.log('  cadence start is interactive — run it in a terminal, or use: cadence report "..."');
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
      console.log('       ✓ set — expires after 2h; update anytime: cadence report "..."\n');
    } else {
      console.log('       skipped — later: cadence report "..."\n');
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
    cadence                     the live instrument (q quits; static when piped)
    cadence --plain             force the static status in a terminal
    cadence start               guided setup (self-report, dials, weather — all skippable)
    cadence report "..."        set your self-report (e.g. "two beers, ship mode")
    cadence report              print current self-report
                                ("cadence state" still works as an alias)
    cadence clear               clear self-report
    cadence test                preview what the hook would inject right now
    cadence signals             every signal — live value, or why it's absent
    cadence pause               silence all hooks (state survives untouched)
    cadence resume              start reading the room again

  dials (your determination — pinned dials override inference):
    cadence dials               show the mixing board and what's pinned here
    cadence set <dial> <level>  pin a dial (level: low|medium|high)
    cadence unset <dial>        un-pin a dial (or: cadence unset all)
                                dials: pace, tone, posture, proactivity
                                (env also works: CADENCE_PACE=fast)
    cadence set <dial> <level> --project    pin for THIS directory only
    cadence unset <dial> --project          un-pin here (or: unset all --project)
    cadence projects            list every directory with project pins
    cadence projects clear      clear this directory's pins (or: clear all)
                                precedence: global < project (deepest dir wins) < env

  environment (time & day are automatic; weather is opt-in):
    cadence set-location <lat> <lon> [name]   turn on weather for your area

  opt-in signals (off until you turn them on — as much as you're willing to give):
    cadence enable <signal> [value]   turn an opt-in signal on (e.g. typingTempo)
    cadence disable <signal>          turn it back off
                                      see them all: cadence signals
    cadence tune                      where your next words pulled against the lens
    cadence tune clear                delete the tune log (enable: cadence enable tuning)

  music (macOS reads Spotify.app / Music.app automatically):
    cadence spotify connect <id>      link Spotify (cross-platform, opens browser)
    cadence spotify off               unlink it

  dj (reverse direction — work transitions steer Spotify; needs Premium):
    cadence dj                        status: link, mappings, last action
    cadence dj setup                  link with playback control + map events
    cadence dj map <event> <uri>      map an event to a track/playlist URI
    cadence dj test <event>           run an event now, errors visible
    cadence dj off                    turn dj off

  other surfaces:
    cadence envelope            print the injectable <user_state> block for ANY
                                agent harness (--json for structured output;
                                empty stdout = nothing to inject, always exit 0)
    cadence mcp                 stdio MCP server — same room in Claude Desktop etc.
                                (don't add it inside Claude Code: hooks already inject)
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return cmdStart();
    case "report":
      return cmdReport(rest);
    case "state": // deprecated alias for `report` — kept for alpha installs
      console.error('  note: "cadence state" is now "cadence report" (alias kept for now)');
      return cmdReport(rest);
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
    case "projects":
      return cmdProjects(rest);
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
    case "tune":
      return cmdTune(rest);
    case "spotify":
      return cmdSpotify(rest);
    case "dj":
      return cmdDj(rest);
    case "envelope":
      // The generic harness primitive: stdout is ONLY the injectable payload
      // (block, JSON, or nothing) — see src/envelope-cli.ts for the contract.
      return cmdEnvelope(rest);
    case "mcp":
      // stdio MCP server: from here on stdout is the JSON-RPC channel — print
      // nothing else. Runs until the client closes stdin.
      return (await import("./mcp.js")).runMcpServer();
    case undefined:
      return cmdRoot(); // the live instrument (static when piped)
    case "--plain":
      return cmdRoot(["--plain"]); // force the static status in a TTY
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
