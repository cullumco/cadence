#!/usr/bin/env node
import { getMusicSignal } from "./providers/music.js";
import { getSelfReportSignal, STALE_AFTER_MS, REFRESH_SOON_MS } from "./providers/selfreport.js";
import { loadOverrides } from "./cadence.js";
import { debug } from "./debug.js";

/* ─────────────────────────────────────────────────────────────────────────
 * Claude Code SessionStart adapter: one short, human-facing line when a
 * session opens — is Cadence live, what does it currently see, and where
 * do you input state. Discoverability, not context: the per-prompt
 * UserPromptSubmit hook owns what the MODEL sees; this line is for YOU
 * (delivered via `systemMessage`, which Claude Code shows to the user).
 *
 * Fires on "startup" only (see hooks/hooks.json matcher) — not on resume
 * or clear — so it reads as a greeting, not a nag.
 * ───────────────────────────────────────────────────────────────────────── */

const BUDGET_MS = 700;

export interface SessionInfo {
  selfReport: string | null; // current state.txt text (TTL already applied)
  selfReportRemainingMs: number | null; // ms left before it goes stale, or null
  pinned: string[]; // dial names pinned in ~/.cadence/config.json
  nowPlaying: { artist: string; player: string } | null;
  firstRun: boolean; // Cadence has never been told anything (no state, no pins)
}

// The voice of the product's first impression. Return null to stay silent.
// Default policy: always one line on startup — say what's seen when there
// are signals, point at the inputs when there's nothing yet, and invite a
// refresh when the self-report is about to go stale ("inquire about updating").
export function composeHint(info: SessionInfo): string | null {
  if (info.firstRun) {
    return 'cadence: on, but it hasn\'t heard from you — try `cadence start` (or just `cadence state "deep work"`)';
  }
  const expiringSoon =
    info.selfReport != null &&
    info.selfReportRemainingMs != null &&
    info.selfReportRemainingMs <= REFRESH_SOON_MS;
  const seen: string[] = [];
  if (info.selfReport) {
    seen.push(`state "${info.selfReport}"${expiringSoon ? " (expiring)" : ""}`);
  }
  if (info.nowPlaying) seen.push(`${info.nowPlaying.player}: ${info.nowPlaying.artist}`);
  if (info.pinned.length) seen.push(`pinned ${info.pinned.join(", ")}`);
  if (seen.length === 0) {
    return 'cadence: live, no signals right now — `cadence state "..."` to give it one';
  }
  // When state is about to expire, the inputs hint becomes an explicit nudge to
  // re-declare — so a long session keeps the cadence honest as the room shifts.
  const tail = expiringSoon
    ? "still in this cadence? `cadence state \"...\"` to refresh"
    : "inputs: cadence state | dials";
  return `cadence: live — ${seen.join(" · ")}  (${tail})`;
}

async function collectInfo(): Promise<SessionInfo> {
  // Race music against the budget — MusicBrainz on a brand-new artist can
  // be slow, and a session greeting must never delay the session.
  const [report, overrides, music] = await Promise.all([
    getSelfReportSignal().catch(() => null),
    loadOverrides(),
    Promise.race([
      getMusicSignal().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS)),
    ]),
  ]);
  const pinned = Object.keys(overrides);
  const remaining = report ? Math.max(0, STALE_AFTER_MS - (Date.now() - report.setAt)) : null;
  return {
    selfReport: report?.text ?? null,
    selfReportRemainingMs: remaining,
    pinned,
    nowPlaying: music?.artist ? { artist: music.artist, player: music.player ?? "music" } : null,
    firstRun: !report && pinned.length === 0,
  };
}

async function main() {
  const hint = composeHint(await collectInfo());
  if (!hint) process.exit(0); // same contract as the prompt hook: silent when empty
  process.stdout.write(JSON.stringify({ systemMessage: hint }));
}

main().catch((err: unknown) => {
  debug("session-start", err instanceof Error ? err.message : String(err));
  process.exit(0); // greeting must never break a session
});
