import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadProviders, providerEnabled, type ProviderConfig } from "./config.js";

/* ─────────────────────────────────────────────────────────────────────────
 * DJ policy — the pure half of reverse-direction actuation.
 *
 * Cadence's settled posture is "influence = prompt only"; DJ is the one
 * deliberate exception, and it's doubly opt-in by construction: every event
 * must be explicitly mapped to a Spotify URI by the user, and unmapped events
 * never act. The hooks only ever DETECT transitions (the edges posttool
 * already computes) and spawn the detached helper (dist/dj-run.js) — every
 * judgment about whether to touch playback lives here, in pure functions
 * with injected clocks, so the discipline is testable without Spotify.
 *
 * Hard invariants the decision encodes:
 *   - never start audio: nothing playing → skip. DJ steers a room that
 *     already has music; it never wakes a speaker.
 *   - gentle by default: a track URI is QUEUED (plays after the current
 *     song); only a playlist/album URI switches context. The URI type IS
 *     the gentleness setting — no extra config knob.
 *   - global cooldown (10 min default) across all events, on top of the
 *     hooks' own once-per-transition edge-triggering.
 *
 * The ship trigger fires ONLY from the explicit `cadence report` path (text
 * matching SHIP_PATTERN — the same authority stop.ts requires). Triggering
 * off live prompt intent (kind === "ship" in hook.ts) is deliberately
 * DEFERRED until real-world intent-regex precision is observed: it's the
 * one trigger that can misfire on ordinary language, and a wrongly switched
 * playlist burns trust in the whole product.
 * ───────────────────────────────────────────────────────────────────────── */

export const DJ_EVENTS = [
  "ship",
  "conflict",
  "conflictResolved",
  "testsRed",
  "testsGreen",
  "thrash",
] as const;
export type DjEvent = (typeof DJ_EVENTS)[number];

export function isDjEvent(name: string): name is DjEvent {
  return (DJ_EVENTS as readonly string[]).includes(name);
}

/* Shipping authority, single source. stop.ts blocked on this exact pattern
 * before DJ existed — it now imports from here so Stop-authority and the DJ
 * ship trigger can never drift apart. */
export const SHIP_PATTERN = /\b(ship|shipping|jamming|locked.?in|sending|grind|just|send it)\b/i;

export const DJ_COOLDOWN_MS = 10 * 60_000;

export type DjMappings = Partial<Record<DjEvent, string>>;

/** Track → queue (gentle, plays after the current song); playlist/album →
 * context switch (interruption the user explicitly chose for that event).
 * Anything else — https URLs, junk, episode/show URIs — is rejected. */
export function classifyUri(uri: string): "queue" | "context" | null {
  if (/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return "queue";
  if (/^spotify:(playlist|album):[A-Za-z0-9]+$/.test(uri)) return "context";
  return null;
}

/** The user's event→URI mappings, validated. Mirrors providerEnabled's
 * tri-state honesty: `providers.dj` absent / false / empty all read as off,
 * and invalid URIs are dropped so junk in the config can never act. */
export function readDjMappings(providers: ProviderConfig): DjMappings {
  if (!providerEnabled(providers, "dj")) return {};
  const dj = providers["dj"];
  if (!dj || typeof dj !== "object") return {};
  const raw = (dj as Record<string, unknown>)["mappings"];
  if (!raw || typeof raw !== "object") return {};
  const out: DjMappings = {};
  for (const [event, uri] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDjEvent(event)) continue;
    if (typeof uri !== "string" || classifyUri(uri) === null) continue;
    out[event] = uri;
  }
  return out;
}

/** Cooldown from `providers.dj.cooldownMin`, defaulting to 10 minutes. */
export function readDjCooldownMs(providers: ProviderConfig): number {
  const dj = providers["dj"];
  if (!dj || typeof dj !== "object") return DJ_COOLDOWN_MS;
  const min = (dj as Record<string, unknown>)["cooldownMin"];
  return typeof min === "number" && Number.isFinite(min) && min > 0
    ? min * 60_000
    : DJ_COOLDOWN_MS;
}

/** DJ needs playback read+write; a legacy read-only Spotify link (no scopes
 * field) fails CLOSED — `cadence dj setup` re-links with the right consent. */
export function hasDjScopes(scopes: string | undefined): boolean {
  if (!scopes) return false;
  const granted = new Set(scopes.split(/\s+/));
  return granted.has("user-read-playback-state") && granted.has("user-modify-playback-state");
}

/** What's playing right now, as dj-run reads it off GET /v1/me/player.
 * `null` player = no active device (204) — indistinguishable from silence. */
export interface PlayerState {
  isPlaying: boolean;
  contextUri?: string;
  trackUri?: string;
}

export interface DjLast {
  lastEvent?: string;
  lastActedAt?: number;
  lastUri?: string;
}

export type DjAction =
  | { act: true; kind: "queue" | "context"; uri: string }
  | { act: false; reason: "unmapped" | "nothing-playing" | "cooldown" | "already-playing" };

/** The whole act-or-skip judgment, pure. Check order is deliberate:
 * unmapped (the feature is inert without explicit consent) → nothing-playing
 * (never start audio) → cooldown (one action per window, across all events)
 * → already-playing (re-steering into the same music is just noise). */
export function decideDjAction(opts: {
  event: DjEvent;
  mappings: DjMappings;
  player: PlayerState | null;
  last: DjLast;
  now: number;
  cooldownMs?: number;
}): DjAction {
  const uri = opts.mappings[opts.event];
  if (!uri) return { act: false, reason: "unmapped" };
  const kind = classifyUri(uri);
  if (!kind) return { act: false, reason: "unmapped" }; // validated upstream; belt and suspenders

  if (!opts.player || !opts.player.isPlaying) return { act: false, reason: "nothing-playing" };

  const cooldownMs = opts.cooldownMs ?? DJ_COOLDOWN_MS;
  if (
    typeof opts.last.lastActedAt === "number" &&
    opts.now - opts.last.lastActedAt < cooldownMs
  ) {
    return { act: false, reason: "cooldown" };
  }

  const playing = kind === "context" ? opts.player.contextUri : opts.player.trackUri;
  if (playing === uri) return { act: false, reason: "already-playing" };

  return { act: true, kind, uri };
}

/** Map posttool's winning transition to exactly one DJ event — the same
 * conflict > tests > thrash priority its message selection uses, so the DJ
 * always reacts to the tell the user was told about. */
export function djEventForTransitions(t: {
  conflictEdge: boolean;
  conflicted: boolean;
  testsEdge: boolean;
  testsFailing: boolean;
  thrashEdge: boolean;
}): DjEvent | null {
  if (t.conflictEdge) return t.conflicted ? "conflict" : "conflictResolved";
  if (t.testsEdge) return t.testsFailing ? "testsRed" : "testsGreen";
  if (t.thrashEdge) return "thrash";
  return null;
}

/* ── the trigger side: detect in the hook, act in a detached child ────────
 * Hooks are triggers, never actors. The spawn is detached + unref'd so
 * Claude Code waits on the hook's exit, not the helper (same lesson as the
 * un-unref'd budget timer). A few ms, after the hook's output is written. */
export function spawnDj(event: DjEvent): void {
  const helper = fileURLToPath(new URL("./dj-run.js", import.meta.url));
  const child = spawn(process.execPath, [helper, event], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** Spawn the helper only when this event is actually mapped — one cheap
 * config read keeps non-DJ users from paying a process spawn per transition.
 * Fail-silent: a broken DJ is indistinguishable from a quiet one. */
export async function maybeSpawnDj(event: DjEvent): Promise<boolean> {
  try {
    const mappings = readDjMappings(await loadProviders());
    if (!mappings[event]) return false;
    spawnDj(event);
    return true;
  } catch {
    return false;
  }
}
