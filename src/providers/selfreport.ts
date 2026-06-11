import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SelfReportSignal } from "../types.js";

const STATE_FILE = join(homedir(), ".cadence", "state.txt");
// 2h, shortened from 4h: a self-report should track the room you're in now, not
// the one you were in this morning. Cadence nudges you to refresh as it nears
// expiry (see session-start composeHint).
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
// When less than this is left, the session greeting invites a refresh.
export const REFRESH_SOON_MS = 30 * 60 * 1000;

export async function getSelfReportSignal(): Promise<SelfReportSignal | null> {
  try {
    const [text, info] = await Promise.all([readFile(STATE_FILE, "utf-8"), stat(STATE_FILE)]);
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (Date.now() - info.mtimeMs > STALE_AFTER_MS) return null;
    return { source: "self_report", text: trimmed, setAt: info.mtimeMs };
  } catch {
    return null;
  }
}
