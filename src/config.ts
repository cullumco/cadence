import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────
 * Config + the opt-in provider registry.
 *
 * `~/.cadence/config.json` already held pinned dials and a weather location.
 * It now also holds a `providers` block — the consent registry. Signals that
 * read something the user might not want shared (their calendar, the app
 * they're in, an esoteric feed) stay OFF until the user names them here:
 *
 *   { "providers": { "typingTempo": true, "focusedApp": true,
 *                     "calendar": { "ics": "https://…" }, "horoscope": "leo" } }
 *
 * The rule is "as many signals as the user is willing to give": nothing
 * privacy-adjacent fires on inference alone. Always resolves — a missing or
 * garbled file reads as "nothing opted in," never throws.
 * ───────────────────────────────────────────────────────────────────────── */

const CONFIG_FILE = join(homedir(), ".cadence", "config.json");

export type ProviderConfig = Record<string, unknown>;

/* The opt-in signals the user can turn on, and a one-line description for the
 * CLI. Adding a row here is what makes `cadence enable <name>` accept it — the
 * single source of truth shared by the CLI, the signals view, and the
 * providers. Grow this as opt-in providers land. */
export const OPT_IN_PROVIDERS: Record<string, string> = {
  typingTempo: "prompt rhythm — rapid-fire vs. one long considered prompt → pace",
  focusedApp: "frontmost non-terminal app (macOS) → flavor in the context line",
  wifi: "wifi network name (macOS) → place context, home vs. office vs. café",
  moon: "current moon phase (offline) → esoteric flavor",
  horoscope: "daily horoscope for your sign, e.g. `cadence enable horoscope leo`",
};

export async function loadConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {}; // no/garbled config → empty, never throw
  }
}

/** The opt-in registry, or `{}` if the user hasn't opted into anything. */
export function readProviders(cfg: Record<string, unknown>): ProviderConfig {
  const p = cfg["providers"];
  return p && typeof p === "object" ? (p as ProviderConfig) : {};
}

export async function loadProviders(): Promise<ProviderConfig> {
  return readProviders(await loadConfig());
}

/* A provider is enabled when its key carries a truthy value: `true`, a config
 * object (`{ ics: "…" }`), or a setting string (`"leo"`). `false`, `null`,
 * empty string, or an empty object all read as "off" — tri-state honesty, so
 * `"horoscope": ""` doesn't silently count as consent. */
export function providerEnabled(providers: ProviderConfig, name: string): boolean {
  const v = providers[name];
  if (v == null || v === false || v === "") return false;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}

/** The raw setting for a provider (e.g. the horoscope sign, the calendar ics
 * object), or undefined when it's off. Lets a provider read its own config
 * without re-parsing the file. */
export function providerSetting(providers: ProviderConfig, name: string): unknown {
  return providerEnabled(providers, name) ? providers[name] : undefined;
}

/* ── pause: the whole-product kill switch ──────────────────────────────────
 * An ambient layer that injects into every prompt needs a visible, instant
 * off switch. `cadence pause` sets `"paused": true`; every hook checks it
 * FIRST and exits silently — no signals read, no subprocesses spawned, no
 * block injected. State (pins, opt-ins, self-report) is preserved untouched,
 * so `cadence resume` picks up exactly where you left off. */
export function readPaused(cfg: Record<string, unknown>): boolean {
  return cfg["paused"] === true;
}

export async function isPaused(): Promise<boolean> {
  return readPaused(await loadConfig());
}
