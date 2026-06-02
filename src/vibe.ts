/* ─────────────────────────────────────────────────────────────────────────
 * vibe.ts — turn noisy genre tags into (a) clean mood words and (b) an
 * averaged energy (0–1). The energy feeds the PACE dial in cadence.ts; the
 * mood words color the rendered block and the TONE dial.
 *
 * Grounded in deep research (see docs/vibe-research.md):
 *   • Mood vocabulary = Cyanite.ai's verified 13-mood controlled set.
 *   • Affect axes = Spotify's published feature definitions:
 *       energy (0–1)  → intensity        → pace dial (fast ↔ deliberate)
 *       valence (0–1) → positiveness     → which mood word (happy ↔ sad)
 *       acoustic      → mellow/organic   → warms the tone dial
 *   • No published genre→affect TABLE exists, so the table below is
 *     hand-authored from genre knowledge. Extensible — add rows as artists miss.
 *
 * Pipeline: raw tags → match GENRE_AFFECT rows → average energy/valence/acoustic
 * → pick mood words. The signal→dial mapping itself lives in cadence.ts.
 * ───────────────────────────────────────────────────────────────────────── */

// Cyanite's controlled vocabulary (the words we're allowed to emit).
export type Mood =
  | "aggressive" | "energetic" | "uplifting" | "happy" | "epic"
  | "chilled" | "calm" | "ethereal" | "romantic" | "sexy"
  | "dark" | "sad" | "scary";

interface Affect {
  energy: number; // 0–1
  valence: number; // 0–1
  acoustic: number; // 0–1 (organic/acoustic-ness)
  moods: Mood[]; // 1–2 characteristic moods for this genre family
}

/* Hand-authored genre→affect table. Keys are lowercase substrings matched
 * against the incoming tags. Values are rough but defensible per the research
 * (energy: death-metal high → Bach low; valence: euphoric high → depressed low).
 * Order doesn't matter — every matching row is averaged. */
const GENRE_AFFECT: Record<string, Affect> = {
  // ── high energy → ship ───────────────────────────────────────────────
  punk: { energy: 0.9, valence: 0.6, acoustic: 0.05, moods: ["aggressive", "energetic"] },
  metal: { energy: 0.95, valence: 0.4, acoustic: 0.02, moods: ["aggressive", "dark"] },
  hardcore: { energy: 0.95, valence: 0.45, acoustic: 0.02, moods: ["aggressive", "energetic"] },
  "drum and bass": { energy: 0.9, valence: 0.6, acoustic: 0.03, moods: ["energetic"] },
  "drum & bass": { energy: 0.9, valence: 0.6, acoustic: 0.03, moods: ["energetic"] },
  techno: { energy: 0.85, valence: 0.55, acoustic: 0.02, moods: ["energetic"] },
  house: { energy: 0.8, valence: 0.7, acoustic: 0.05, moods: ["energetic", "uplifting"] },
  "dance": { energy: 0.82, valence: 0.75, acoustic: 0.05, moods: ["energetic", "happy"] },
  "electronic": { energy: 0.75, valence: 0.6, acoustic: 0.05, moods: ["energetic"] },
  "hip hop": { energy: 0.75, valence: 0.6, acoustic: 0.1, moods: ["energetic"] },
  "hip-hop": { energy: 0.75, valence: 0.6, acoustic: 0.1, moods: ["energetic"] },
  rap: { energy: 0.75, valence: 0.55, acoustic: 0.1, moods: ["energetic"] },
  rock: { energy: 0.78, valence: 0.55, acoustic: 0.15, moods: ["energetic"] },
  pop: { energy: 0.72, valence: 0.78, acoustic: 0.15, moods: ["happy", "uplifting"] },
  funk: { energy: 0.75, valence: 0.8, acoustic: 0.1, moods: ["happy", "energetic"] },
  disco: { energy: 0.8, valence: 0.85, acoustic: 0.1, moods: ["happy", "uplifting"] },

  // ── mid / groovy → ship-or-think depending on energy ─────────────────
  "r&b": { energy: 0.55, valence: 0.6, acoustic: 0.2, moods: ["sexy", "chilled"] },
  soul: { energy: 0.55, valence: 0.65, acoustic: 0.25, moods: ["romantic", "uplifting"] },
  reggae: { energy: 0.6, valence: 0.75, acoustic: 0.2, moods: ["chilled", "happy"] },
  indie: { energy: 0.6, valence: 0.55, acoustic: 0.3, moods: ["chilled"] },

  // ── low energy, organic → think ──────────────────────────────────────
  ambient: { energy: 0.2, valence: 0.5, acoustic: 0.6, moods: ["ethereal", "calm"] },
  "lo-fi": { energy: 0.3, valence: 0.5, acoustic: 0.4, moods: ["chilled", "calm"] },
  lofi: { energy: 0.3, valence: 0.5, acoustic: 0.4, moods: ["chilled", "calm"] },
  chillout: { energy: 0.3, valence: 0.55, acoustic: 0.4, moods: ["chilled", "calm"] },
  chill: { energy: 0.35, valence: 0.55, acoustic: 0.4, moods: ["chilled"] },
  downtempo: { energy: 0.4, valence: 0.5, acoustic: 0.35, moods: ["chilled", "ethereal"] },
  "trip hop": { energy: 0.45, valence: 0.4, acoustic: 0.3, moods: ["dark", "chilled"] },
  "trip-hop": { energy: 0.45, valence: 0.4, acoustic: 0.3, moods: ["dark", "chilled"] },
  classical: { energy: 0.3, valence: 0.5, acoustic: 0.9, moods: ["epic", "calm"] },
  acoustic: { energy: 0.3, valence: 0.55, acoustic: 0.9, moods: ["calm", "romantic"] },
  folk: { energy: 0.4, valence: 0.55, acoustic: 0.8, moods: ["calm", "romantic"] },
  jazz: { energy: 0.45, valence: 0.55, acoustic: 0.6, moods: ["chilled", "sexy"] },
  "nu jazz": { energy: 0.5, valence: 0.55, acoustic: 0.4, moods: ["chilled"] },
  "singer-songwriter": { energy: 0.4, valence: 0.5, acoustic: 0.7, moods: ["calm", "sad"] },
  "post-rock": { energy: 0.5, valence: 0.4, acoustic: 0.4, moods: ["epic", "ethereal"] },
  shoegaze: { energy: 0.55, valence: 0.4, acoustic: 0.3, moods: ["ethereal", "dark"] },

  // ── low energy, low valence → debug-leaning ──────────────────────────
  blues: { energy: 0.45, valence: 0.35, acoustic: 0.5, moods: ["sad", "dark"] },
  slowcore: { energy: 0.25, valence: 0.3, acoustic: 0.5, moods: ["sad", "dark"] },
  sad: { energy: 0.3, valence: 0.2, acoustic: 0.5, moods: ["sad"] },
  melancholy: { energy: 0.3, valence: 0.25, acoustic: 0.5, moods: ["sad", "dark"] },
  melancholic: { energy: 0.3, valence: 0.25, acoustic: 0.5, moods: ["sad", "dark"] },
  doom: { energy: 0.5, valence: 0.2, acoustic: 0.2, moods: ["dark", "scary"] },
};

export interface Vibe {
  moods: Mood[]; // 2–4 clean adjectives, ordered by salience
  energy: number; // averaged 0–1 — feeds the pace dial in cadence.ts
}

/** Match a list of raw tags against the affect table and aggregate. */
export function tagsToVibe(tags: string[]): Vibe | null {
  const hits: Affect[] = [];
  for (const raw of tags) {
    const t = raw.toLowerCase();
    for (const key in GENRE_AFFECT) {
      if (t.includes(key)) {
        hits.push(GENRE_AFFECT[key]!);
        break; // one row per tag — don't double-count "trip hop" as "hop"
      }
    }
  }
  if (hits.length === 0) return null;

  const energy =
    hits.reduce((s, a) => s + a.energy, 0) / hits.length;

  // Mood words: collect from all hits, dedupe, keep most frequent first.
  const moodCounts = new Map<Mood, number>();
  for (const h of hits) for (const m of h.moods) {
    moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1);
  }
  const moods = [...moodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([m]) => m);

  return { moods, energy };
}
