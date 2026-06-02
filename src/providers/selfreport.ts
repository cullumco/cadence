import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SelfReportSignal } from "../types.js";

const STATE_FILE = join(homedir(), ".cadence", "state.txt");
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

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
