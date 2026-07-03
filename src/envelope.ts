/* ─────────────────────────────────────────────────────────────────────────
 * The portable collection seam: signals → dials → rendered envelope.
 *
 * Every surface (the UserPromptSubmit hook, the CLI preview, the MCP server)
 * must read the SAME room — a third surface must not become a third copy of
 * the collection wiring. Adapter-specific delivery (hook JSON, console
 * printing, JSON-RPC framing) stays in the adapters; this file owns "which
 * providers, in one budget-raced pass, into one rendered block."
 * ───────────────────────────────────────────────────────────────────────── */
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal } from "./providers/selfreport.js";
import { getEnvironmentSignal } from "./providers/environment.js";
import { getGitSignal } from "./providers/git.js";
import { getActivitySignal } from "./providers/activity.js";
import { getIntentSignal } from "./providers/intent.js";
import { getEsotericSignal } from "./providers/esoteric.js";
import { deriveCadence, buildReframe, loadOverrides, applyOverrides } from "./cadence.js";
import { loadProviders, providerEnabled } from "./config.js";
import type { ProviderConfig } from "./config.js";
import { render } from "./inject.js";
import type { Signal, UserState, StateWithCadence } from "./types.js";

/* The full prompt-time provider set, used by the hook. Providers never throw
 * by contract, but allSettled keeps one misbehaving probe from sinking the
 * rest anyway. */
export async function collectSignals(
  cwd: string,
  prompt: string | undefined,
  providers: ProviderConfig
): Promise<Signal[]> {
  const tempoEnabled = providerEnabled(providers, "typingTempo");
  const [music, report, environment, git, activity, intent, esoteric] = await Promise.allSettled([
    getMusicSignal(providers),
    getSelfReportSignal(),
    getEnvironmentSignal(new Date(), {
      focusedAppEnabled: providerEnabled(providers, "focusedApp"),
      wifiEnabled: providerEnabled(providers, "wifi"),
    }),
    getGitSignal(cwd),
    getActivitySignal(prompt, Date.now(), { tempoEnabled }),
    getIntentSignal(prompt),
    getEsotericSignal(providers),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (environment.status === "fulfilled" && environment.value) signals.push(environment.value);
  if (git.status === "fulfilled" && git.value) signals.push(git.value);
  if (activity.status === "fulfilled" && activity.value) signals.push(activity.value);
  if (intent.status === "fulfilled" && intent.value) signals.push(intent.value);
  if (esoteric.status === "fulfilled" && esoteric.value) signals.push(esoteric.value);
  return signals;
}

export interface Envelope {
  block: string; // the rendered <user_state> text, exactly what the hook would inject
  state: StateWithCadence; // the structured form, for JSON surfaces
}

/* The READ-surface provider set deliberately excludes two of the hook's
 * providers: activity (getActivitySignal WRITES the activity.json prompt mark —
 * a preview or resource read is not a prompt and must not pollute the tempo
 * window) and intent (there is no live prompt on these surfaces). */
async function collectReadSignals(
  cwd: string,
  providers: ProviderConfig,
  now: () => number
): Promise<Signal[]> {
  const [music, report, environment, git, esoteric] = await Promise.allSettled([
    getMusicSignal(providers),
    getSelfReportSignal(),
    getEnvironmentSignal(new Date(now()), {
      focusedAppEnabled: providerEnabled(providers, "focusedApp"),
      wifiEnabled: providerEnabled(providers, "wifi"),
    }),
    getGitSignal(cwd),
    getEsotericSignal(providers),
  ]);
  const signals: Signal[] = [];
  if (music.status === "fulfilled" && music.value) signals.push(music.value);
  if (report.status === "fulfilled" && report.value) signals.push(report.value);
  if (environment.status === "fulfilled" && environment.value) signals.push(environment.value);
  if (git.status === "fulfilled" && git.value) signals.push(git.value);
  if (esoteric.status === "fulfilled" && esoteric.value) signals.push(esoteric.value);
  return signals;
}

/* One fresh collection → derive → render pass, bounded by budgetMs.
 * Returns null on "no signals AND no pinned dials" (same semantics as the
 * hook's silent exit — the caller decides what silence means on its surface). */
export async function buildEnvelope(opts: {
  cwd: string;
  budgetMs: number;
  now?: () => number;
}): Promise<Envelope | null> {
  const now = opts.now ?? Date.now;
  // Pins + the opt-in registry are tiny local reads; load them first so
  // collection knows which opt-in providers to run, then race only the
  // subprocess-heavy collection against the budget. cwd scopes project pins.
  const [overrides, providers] = await Promise.all([loadOverrides(opts.cwd), loadProviders()]);
  const signals = await Promise.race<Signal[]>([
    collectReadSignals(opts.cwd, providers, now),
    // unref: the losing timer must not hold the caller's process open after
    // the race settles (the June eval found exactly this latency bug).
    new Promise<Signal[]>((resolve) =>
      setTimeout(() => resolve([]), opts.budgetMs).unref()
    ),
  ]);

  if (signals.length === 0 && Object.keys(overrides).length === 0) return null;

  const state: UserState = { signals, capturedAt: now() };
  const { cadence, pinned } = applyOverrides(deriveCadence(state), overrides);
  const reframe = buildReframe(cadence);
  const stateWithCadence: StateWithCadence = { ...state, cadence, pinned, reframe };
  return { block: render(stateWithCadence), state: stateWithCadence };
}
