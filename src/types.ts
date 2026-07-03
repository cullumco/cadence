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
 *   - IntentSignal     → what your prompt implies  (mood, inferred from words)
 *   - ActivitySignal   → your motor/typing tempo   (mood, inferred)
 *   - GitSignal        → your work state           (context)
 *   - PlaceSignal      → where & in what setting    (place)
 * ───────────────────────────────────────────────────────────────────────── */

export interface MusicSignal {
  source: "music";
  track?: string;
  artist?: string;
  player?: string; // macOS: "Spotify" | "Music"; Linux: MPRIS player name
  vibe?: string; // clean mood words derived from genre tags, e.g. "chilled, calm"
  energy?: number; // 0–1 averaged from genre tags — feeds the pace + posture dials
  acoustic?: number; // 0–1 organic-ness — warms the tone dial when high
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
  // typing tempo — only set when the user opts into providers.typingTempo.
  // "rapid"     → quick succession of short prompts → fast pace
  // "considered" → one long, deliberate prompt       → slow pace
  // "measured"  → neither extreme                    → no nudge
  tempo?: "rapid" | "measured" | "considered";
}

/* Prompt intent — the cadence read straight from the words just typed.
 * Weaker than a deliberate self-report, stronger than git inference. */
export interface IntentSignal {
  source: "intent";
  kind: "ship" | "think" | "debug" | "review" | "focus" | null;
}

/* Esoteric flavor — opt-in, render-only, never moves a dial. */
export interface EsotericSignal {
  source: "esoteric";
  moonPhase?: string; // computed offline from the date
  horoscope?: string; // daily text for the configured sign (keyless, opt-in)
  sign?: string; // the configured zodiac sign
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
 * weather is opt-in (needs a config-set location + network); battery is
 * macOS (pmset) + Linux (sysfs).
 * Renders as flavor AND applies soft dial nudges (see deriveCadence). */
export interface EnvironmentSignal {
  source: "environment";
  partOfDay: "early morning" | "morning" | "midday" | "afternoon" | "evening" | "late night";
  dayOfWeek: string; // "monday" … "sunday"
  isWeekend: boolean;
  hour: number; // 0–23, for nudge thresholds
  weather?: string; // "rainy", "clear", "snowy" … only if location configured
  onBattery?: boolean; // macOS/Linux: unplugged → likely mobile
  batteryPct?: number; // macOS/Linux: 0–100, "8% left → wrap up"
  // machine vitals (cross-platform, pure Node)
  uptimeHours?: number; // os.uptime() — long uptime → fatigue
  loadHigh?: boolean; // os.loadavg vs cpu count — busy machine
  // mac context (best-effort shell-outs; flavor only)
  focus?: boolean; // Do Not Disturb / Focus on → heads-down
  displays?: number; // external monitors → "at the desk"
  network?: string; // wifi SSID → home / office / café
  darkMode?: boolean; // UI dark mode → night session
  focusedApp?: string; // opt-in: frontmost non-terminal app (macOS) → flavor
}

export type Signal =
  | MusicSignal
  | SelfReportSignal
  | ActivitySignal
  | IntentSignal
  | GitSignal
  | PlaceSignal
  | EnvironmentSignal
  | EsotericSignal;

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
