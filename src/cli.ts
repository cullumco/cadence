#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getAmbientSignal } from "./providers/ambient.js";
import { getGitSignal } from "./providers/git.js";
import {
  deriveCadence,
  buildReframe,
  loadOverrides,
  applyOverrides,
  DIALS,
  DIAL_WORDS,
} from "./cadence.js";
import { render } from "./inject.js";
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

async function cmdTest() {
  const signals: Signal[] = [];
  const [music, report, ambient, git, overrides] = await Promise.all([
    getMusicSignal().catch(() => null),
    getSelfReportSignal().catch(() => null),
    getAmbientSignal(new Date()).catch(() => null),
    getGitSignal(process.cwd()).catch(() => null),
    loadOverrides(),
  ]);
  if (music) signals.push(music);
  if (report) signals.push(report);
  if (ambient) signals.push(ambient);
  if (git) signals.push(git);

  if (signals.length === 0 && Object.keys(overrides).length === 0) {
    console.log('  (no signals — play something, set: cadence state "...", or pin a dial: cadence set pace fast)');
    return;
  }

  const state: UserState = { signals, capturedAt: Date.now() };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const reframe = buildReframe(cadence);
  console.log("\n" + render({ ...state, cadence, pinned, reframe }) + "\n");
}

const LEVELS: DialLevel[] = ["low", "medium", "high"];

// Accept EITHER the level ("high") or the human word ("fast") — the user
// thinks in the words the dials board shows, not the internal levels.
function resolveLevel(dial: keyof Cadence, input: string): DialLevel | null {
  const v = input.toLowerCase();
  if ((LEVELS as string[]).includes(v)) return v as DialLevel;
  for (const lvl of LEVELS) {
    if (DIAL_WORDS[dial][lvl].toLowerCase() === v) return lvl;
  }
  return null;
}

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
  const level = resolveLevel(d, value);
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

const HELP = `
  cadence — agents that read the room

  daily:
    cadence state "..."         set self-reported state (e.g. "two beers, ship mode")
    cadence state               print current self-reported state
    cadence clear               clear self-reported state
    cadence test                preview what the hook would inject right now

  dials (your determination — pinned dials override inference):
    cadence dials               show the mixing board and what's pinned
    cadence set <dial> <level>  pin a dial (level: low|medium|high)
    cadence unset <dial>        un-pin a dial (or: cadence unset all)
                                dials: pace, tone, posture, proactivity
                                (env also works: CADENCE_PACE=fast)

  ambient (time & day are automatic; weather is opt-in):
    cadence set-location <lat> <lon> [name]   turn on weather for your area
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "state":
      return cmdState(rest);
    case "clear":
      return cmdClear();
    case "test":
      return cmdTest();
    case "set":
      return cmdSet(rest);
    case "unset":
      return cmdUnset(rest);
    case "dials":
      return cmdDials();
    case "set-location":
      return cmdLocation(rest);
    case undefined:
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
