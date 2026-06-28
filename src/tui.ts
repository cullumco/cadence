/* ─────────────────────────────────────────────────────────────────────────
 * The Instrument — the live face behind a bare `cadence` in a real terminal.
 *
 * Two layers, same seam as the rest of the product:
 *   - renderInstrument()/fader() are PURE — injected clock/width/signals,
 *     no I/O, no ANSI when color is off — so the whole board is testable
 *     against dist/ like everything else.
 *   - runInstrument() is the adapter: alt-screen, raw keys, a 2s tick with
 *     an in-flight guard so slow probes (osascript, git) can never pile up.
 *
 * Read-only on purpose: pins go through the explicit `cadence set` verb,
 * never through a keypress on the board. CLI-only by construction — no hook
 * imports this file, so budget/silent-when-empty are untouched.
 * ───────────────────────────────────────────────────────────────────────── */
import { emitKeypressEvents } from "node:readline";
import type { Cadence, DialLevel, EsotericSignal } from "./types.js";
import { DIALS, DIAL_WORDS } from "./cadence.js";
import {
  musicValue,
  reportValue,
  gitValue,
  LABEL_W,
  type RawSignals,
} from "./signals-view.js";
import { environmentParts } from "./inject.js";

export const TICK_MS = 2000;

export interface InstrumentFrame {
  cadence: Cadence;
  pinned: (keyof Cadence)[];
  reframe: string;
  raw: RawSignals; // meters reuse the signals-view data verbatim
  esoteric: EsotericSignal | null;
  now: number; // injected clock — the renderer stays pure
  paused: boolean;
}

export interface RenderOpts {
  width: number; // pre-clamped by the caller
  color: boolean; // false = zero ANSI bytes, what the tests assert against
}

// Horizontal fader: a ─ track with the thumb at a deterministic index per
// level. ◆ = pinned by the user (matches the * convention in inject.ts),
// ◉ = inferred.
export function fader(level: DialLevel, trackWidth: number, pinned: boolean): string {
  const idx =
    level === "low" ? 2 : level === "high" ? trackWidth - 3 : Math.floor(trackWidth / 2);
  const thumb = pinned ? "◆" : "◉";
  return "─".repeat(idx) + thumb + "─".repeat(Math.max(0, trackWidth - idx - 1));
}

// Left text + right text on one line; padding computed on PLAIN strings, so
// any coloring must happen via `paint` after layout, never before.
function lineLR(left: string, right: string, width: number, paint?: (s: string) => string): string {
  const gap = Math.max(2, width - left.length - right.length);
  return left + " ".repeat(gap) + (paint ? paint(right) : right);
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const LIVE = "▮▮"; // signal present right now
const DORMANT = "░░"; // absent, or only exists per-prompt inside the hook

export function renderInstrument(frame: InstrumentFrame, opts: RenderOpts): string {
  const { width, color } = opts;
  // Monochrome by decision: dim + bold only (NO_COLOR drops even those).
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[22m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);

  const clock = new Date(frame.now);
  const hms = [clock.getHours(), clock.getMinutes(), clock.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

  const lines: string[] = [];
  lines.push(lineLR("  cadence — the instrument", hms, width, dim));
  lines.push("");

  // ── dials ──────────────────────────────────────────────────────────────
  if (frame.paused) {
    lines.push("  paused — prompts go through untouched (cadence resume)");
  } else {
    lines.push(lineLR("  dials", "* = pinned by you", width, dim));
    const trackW = Math.max(10, width - 54);
    for (const dial of DIALS) {
      const pinned = frame.pinned.includes(dial);
      const words = DIAL_WORDS[dial];
      const level = frame.cadence[dial];
      const left =
        `  ${dial.padEnd(LABEL_W + 2)}` +
        `${words.low.padEnd(11)}${fader(level, trackW, pinned)}  ${words.high}`;
      lines.push(lineLR(left, pinned ? `${words[level]}*` : words[level], width, bold));
    }
  }
  lines.push("");

  // ── meters — same vocabulary as `cadence signals`, shared formatters ──
  const meter = (label: string, live: boolean, value: string): string => {
    const line = `  ${label.padEnd(LABEL_W + 1)}${live ? LIVE : DORMANT} ${value}`;
    return live ? line : dim(line);
  };
  lines.push("  meters");
  const { music, report, git, environment } = frame.raw;
  if (music?.track) {
    lines.push(meter("music", true, musicValue(music)));
    if (music.vibe) lines.push(`${" ".repeat(LABEL_W + 6)}vibe: ${music.vibe}`);
  } else {
    lines.push(meter("music", false, "nothing playing"));
  }
  lines.push(
    report
      ? meter("self_report", true, reportValue(report, frame.now))
      : meter("self_report", false, 'none set (cadence report "...")')
  );
  lines.push(
    git
      ? meter("git", true, gitValue(git))
      : meter("git", false, "not a git repo (signal is per-directory)")
  );
  lines.push(
    environment
      ? meter("environment", true, environmentParts(environment).join(", "))
      : meter("environment", false, "unavailable")
  );
  if (frame.esoteric) {
    const parts = [
      frame.esoteric.moonPhase ? `moon ${frame.esoteric.moonPhase}` : null,
      frame.esoteric.horoscope
        ? `${frame.esoteric.sign ?? "horoscope"}: ${frame.esoteric.horoscope}`
        : null,
    ].filter(Boolean);
    if (parts.length) lines.push(meter("esoteric", true, parts.join(" · ")));
  }
  lines.push(meter("intent", false, "reads your prompt (per-turn, in the hook)"));
  lines.push(meter("activity", false, "session-only (injected per-prompt)"));
  lines.push("");

  // ── readout — the exact reframe the hook would inject ─────────────────
  lines.push("  readout");
  wrap(frame.reframe, width - 4).forEach((l, i) => {
    lines.push(i === 0 ? `  > ${l}` : `    ${l}`);
  });
  lines.push("");

  lines.push(
    lineLR("  q quit · r refresh now · pin: cadence set <dial> <level>", "↻ 2s", width, dim)
  );
  return lines.join("\n");
}

/* ── interactive loop ──────────────────────────────────────────────────────
 * Full-frame repaint (cursor home + erase-to-EOL per line + erase-below) —
 * no diffing, no flicker. The in-flight guard means a slow provider sweep
 * degrades the refresh rate instead of stacking subprocesses. */
export async function runInstrument(collect: () => Promise<InstrumentFrame>): Promise<void> {
  const out = process.stdout;
  const color = process.env["NO_COLOR"] == null;
  let inFlight = false;
  let done = false;

  const width = () => Math.max(60, Math.min(84, out.columns ?? 80));

  const paint = async () => {
    if (inFlight || done) return;
    inFlight = true;
    try {
      const frame = await collect();
      if (done) return;
      const body = renderInstrument(frame, { width: width(), color });
      out.write("\x1b[H" + body.split("\n").map((l) => l + "\x1b[K").join("\n") + "\n\x1b[0J");
    } catch {
      // a failed sweep skips one frame — the board itself never crashes
    } finally {
      inFlight = false;
    }
  };

  out.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J"); // alt screen + hidden cursor
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const tick = setInterval(() => void paint(), TICK_MS);

  return new Promise<void>((resolve) => {
    // Idempotent: reachable from keypress, SIGINT, and SIGTERM; the `exit`
    // listener below is the synchronous last resort for crash paths.
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(tick);
      process.stdin.off("keypress", onKey);
      out.off("resize", onResize);
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      process.off("exit", onExit);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      out.write("\x1b[?25h\x1b[?1049l"); // cursor back, primary screen back
      process.stdin.pause();
      resolve();
    };
    const onExit = () => {
      if (!done) out.write("\x1b[?25h\x1b[?1049l");
    };
    const onKey = (
      _str: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined
    ) => {
      if (!key) return;
      if (key.name === "q" || key.name === "escape" || (key.ctrl === true && key.name === "c")) {
        cleanup();
      } else if (key.name === "r") {
        void paint();
      }
    };
    const onResize = () => void paint();
    const onSig = () => cleanup();

    process.stdin.on("keypress", onKey);
    out.on("resize", onResize);
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    process.on("exit", onExit);
    void paint();
  });
}
