/* ─────────────────────────────────────────────────────────────────────────
 * CADENCE_DEBUG=1 surfaces swallowed provider errors on stderr.
 *
 * Providers are fail-silent by contract: a broken signal must degrade to
 * "no signal," never break the hook. But fail-silent code can mask a
 * 100%-reproducible bug (see: the AppleScript that never compiled). This
 * is the escape hatch — stderr only, never stdout, because stdout is the
 * hook protocol channel Claude Code parses.
 *
 *   CADENCE_DEBUG=1 node bin/cadence test
 * ───────────────────────────────────────────────────────────────────────── */

const DEBUG =
  process.env["CADENCE_DEBUG"] === "1" || process.env["CADENCE_DEBUG"] === "true";

export function debug(scope: string, msg: string): void {
  if (!DEBUG) return;
  process.stderr.write(`[cadence:${scope}] ${msg}\n`);
}
