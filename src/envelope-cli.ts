/* ─────────────────────────────────────────────────────────────────────────
 * `cadence envelope` — the one blessed integration primitive for ANY agent
 * harness. Run it in a pre-prompt hook and prepend its stdout verbatim:
 *
 *   - default: the rendered <user_state> block, exactly what the Claude Code
 *     hook injects
 *   - --json:  the structured StateWithCadence (signals, dials, pinned,
 *     reframe) for harnesses that template it themselves
 *
 * Contract (the reason shell integrations can trust stdout blindly):
 *   - paused        → one honest notice line, exit 0 ("off" never reads as
 *                     "broken" — same legibility rule as the MCP server)
 *   - empty room    → NO stdout, exit 0 — empty means "inject nothing"
 *   - signal failure→ NO stdout, exit 0 — a broken probe must never break a
 *                     harness's prompt path (CADENCE_DEBUG=1 shows the cause)
 *   - exit 1 only for usage errors (an unknown flag should fail loudly at
 *     setup time, not silently inject nothing forever)
 *
 * This is the READ surface: it goes through buildEnvelope()'s read-provider
 * set (same as the MCP server), so it never writes ~/.cadence — previewing
 * or injecting the room is not a prompt and must not pollute the activity
 * tempo window.
 * ───────────────────────────────────────────────────────────────────────── */
import { buildEnvelope } from "./envelope.js";
import type { Envelope } from "./envelope.js";
import { isPaused } from "./config.js";
import { debug } from "./debug.js";

// Same posture as the MCP server's READ_BUDGET_MS: looser than the Claude
// hook's 1500ms (this isn't on Claude's prompt-submit critical path) but
// still bounded — the calling harness blocks on this process.
export const ENVELOPE_BUDGET_MS = 2000;

export const ENVELOPE_PAUSED_TEXT =
  "(cadence is paused — run `cadence resume` to turn it back on)";

/* Injected seams so runEnvelope stays a pure policy function (the repo's
 * injected-deps test style, mirroring McpDeps); cmdEnvelope wires the real
 * ones. */
export interface EnvelopeCliDeps {
  buildEnvelope: (opts: { cwd: string; budgetMs: number }) => Promise<Envelope | null>;
  isPaused: () => Promise<boolean>;
  cwd: () => string;
  write: (text: string) => void; // stdout — ONLY ever the injectable payload
  writeErr: (text: string) => void; // stderr — usage errors, never injected
}

/** Returns the process exit code. 0 for every signal-side outcome (paused,
 * empty, failed); 1 only for usage errors. Never throws. */
export async function runEnvelope(args: string[], deps: EnvelopeCliDeps): Promise<number> {
  const json = args.includes("--json");
  const unknown = args.find((a) => a !== "--json");
  if (unknown !== undefined) {
    deps.writeErr(`  unknown option for cadence envelope: "${unknown}"\n`);
    deps.writeErr("  usage: cadence envelope [--json]\n");
    return 1;
  }
  try {
    // Paused is checked FIRST, before any probes run — the kill-switch rule
    // every Cadence surface follows.
    if (await deps.isPaused()) {
      deps.write((json ? JSON.stringify({ paused: true }) : ENVELOPE_PAUSED_TEXT) + "\n");
      return 0;
    }
    const envelope = await deps.buildEnvelope({ cwd: deps.cwd(), budgetMs: ENVELOPE_BUDGET_MS });
    if (!envelope) return 0; // honest empty: no signals, no pins → say nothing
    deps.write((json ? JSON.stringify(envelope.state) : envelope.block) + "\n");
    return 0;
  } catch (e) {
    debug("envelope", e instanceof Error ? e.message : String(e));
    return 0; // fail-silent: degrade to "inject nothing," never break the caller
  }
}

/** The `cadence envelope` entry cli.ts dispatches to. */
export async function cmdEnvelope(args: string[]): Promise<void> {
  const code = await runEnvelope(args, {
    buildEnvelope,
    isPaused,
    cwd: () => process.cwd(),
    write: (t) => process.stdout.write(t),
    writeErr: (t) => process.stderr.write(t),
  });
  if (code !== 0) process.exit(code);
}
