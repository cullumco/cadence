/* ─────────────────────────────────────────────────────────────────────────
 * Cadence signal types.
 *
 * Music is now IDENTITY-ONLY. Spotify's audio-features endpoint was
 * deprecated for new apps (2024-11-27) and dev-mode went Premium-only
 * (2026-02), so energy/valence/tempo are gone. Track + artist come from
 * the OS now-playing channel instead — no auth, no Premium, any player.
 *
 * The four embodied dimensions, each a provider emitting one Signal:
 *   - MusicSignal      → what's playing            (music)
 *   - SelfReportSignal → what you told us          (mood, ground truth)
 *   - ActivitySignal   → your motor/typing tempo   (mood, inferred)
 *   - GitSignal        → your work state           (context)
 *   - PlaceSignal      → where & in what setting    (place)
 * ───────────────────────────────────────────────────────────────────────── */

export interface MusicSignal {
  source: "music";
  track?: string;
  artist?: string;
  player?: string; // "Spotify" | "Music"
  vibe?: string; // clean mood words derived from genre tags, e.g. "chilled, calm"
  energy?: number; // 0–1 averaged from genre tags — feeds the pace dial
}

export interface SelfReportSignal {
  source: "self_report";
  text: string;
  setAt: number;
}

export interface ActivitySignal {
  source: "activity";
  minSinceLastPrompt?: number; // gap before this prompt — flow vs. return-from-break
  promptLength?: number; // chars in the current prompt — terse vs. rambling
}

export interface GitSignal {
  source: "git";
  commitsLastHour: number;
  minSinceLastCommit?: number;
  filesDirty: number;
  conflicted: boolean; // mid-merge / mid-rebase / unresolved conflicts
}

export interface PlaceSignal {
  source: "place";
  network?: string; // wifi SSID — home / office / coffeeshop
  displays?: number; // external monitors → "at the desk, dug in"
}

/* Ambient context — cheap, mostly-local atmosphere. time/day are universal and
 * dependency-free (the one signal that works on every OS, never absent);
 * weather is opt-in (needs a config-set location + network); battery is macOS.
 * Renders as flavor AND applies soft dial nudges (see deriveCadence). */
export interface AmbientSignal {
  source: "ambient";
  partOfDay: "early morning" | "morning" | "midday" | "afternoon" | "evening" | "late night";
  dayOfWeek: string; // "monday" … "sunday"
  isWeekend: boolean;
  hour: number; // 0–23, for nudge thresholds
  weather?: string; // "rainy", "clear", "snowy" … only if location configured
  onBattery?: boolean; // macOS: unplugged → likely mobile
}

export type Signal =
  | MusicSignal
  | SelfReportSignal
  | ActivitySignal
  | GitSignal
  | PlaceSignal
  | AmbientSignal;

export interface UserState {
  signals: Signal[];
  capturedAt: number;
}

/* The mixing board. Instead of collapsing state into one mode label, Cadence
 * drives four INDEPENDENT dials — so high-energy-but-melancholy music can read
 * as "fast pace, warm tone" (a thing one mode word could never express).
 * Each dial is a 3-level spectrum; see DIAL_WORDS in cadence.ts for the
 * human-facing word at each level. */
export type DialLevel = "low" | "medium" | "high";

export interface Cadence {
  pace: DialLevel; // low = deliberate/expansive · high = fast/terse
  tone: DialLevel; // low = warm/casual · high = crisp/professional
  posture: DialLevel; // low = exploratory (options) · high = decisive (the call)
  proactivity: DialLevel; // low = ask-first · high = act without checking in
}

export interface StateWithCadence extends UserState {
  cadence: Cadence;
  pinned: (keyof Cadence)[]; // dials the user set by hand (override inference)
  reframe: string; // interpretation lens: how to READ the prompt, given the dials
}
