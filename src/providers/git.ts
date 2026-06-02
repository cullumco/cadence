import { exec } from "node:child_process";
import type { GitSignal } from "../types.js";

/* ─────────────────────────────────────────────────────────────────────────
 * git work-state — the honest "what are you actually doing" signal.
 *
 * Cross-platform (git is git everywhere). Reads the repo at `cwd` — which,
 * when run from the hook, is the project Claude Code is working in.
 *
 * Rendered as flavor for now: commits this hour, dirty files, and whether
 * you're mid-merge/rebase (the real debug tell). No dial nudges yet — we
 * watch the output first, then decide what should steer.
 * ───────────────────────────────────────────────────────────────────────── */

const GIT_TIMEOUT_MS = 700;

function git(args: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = exec(
      `git ${args}`,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim())
    );
    child.on("error", () => resolve(null));
  });
}

export async function getGitSignal(cwd: string = process.cwd()): Promise<GitSignal | null> {
  // Bail fast if this isn't a repo — cheapest possible check.
  const inRepo = await git("rev-parse --is-inside-work-tree", cwd);
  if (inRepo !== "true") return null;

  const [statusOut, logOut, mergeHead, rebaseDir] = await Promise.all([
    git("status --porcelain", cwd),
    // commit timestamps (unix) in the last hour
    git('log --since="1 hour ago" --format=%ct', cwd),
    git("rev-parse --verify -q MERGE_HEAD", cwd), // non-null ⇒ mid-merge
    git("rev-parse --git-path rebase-merge", cwd), // path exists ⇒ mid-rebase
  ]);

  const filesDirty = statusOut ? statusOut.split("\n").filter(Boolean).length : 0;
  const commitsLastHour = logOut ? logOut.split("\n").filter(Boolean).length : 0;

  // conflict markers in `status --porcelain`: UU, AA, DD, AU, UA, DU, UD
  const conflicted =
    mergeHead != null ||
    (statusOut != null && /^(UU|AA|DD|AU|UA|DU|UD) /m.test(statusOut));

  // minutes since most recent commit, if any in the window
  let minSinceLastCommit: number | undefined;
  if (logOut) {
    const newest = Math.max(...logOut.split("\n").filter(Boolean).map(Number));
    if (Number.isFinite(newest)) {
      minSinceLastCommit = Math.round((Date.now() / 1000 - newest) / 60);
    }
  }

  void rebaseDir; // reserved: rebase detection refinement (see BACKLOG)

  return {
    source: "git",
    commitsLastHour,
    minSinceLastCommit,
    filesDirty,
    conflicted,
  };
}
