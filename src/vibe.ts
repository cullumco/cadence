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
  // ── high energy → pace high ──────────────────────────────────────────
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

  "post-hardcore": { energy: 0.85, valence: 0.45, acoustic: 0.05, moods: ["aggressive", "energetic"] },
  "post-punk": { energy: 0.7, valence: 0.4, acoustic: 0.1, moods: ["dark", "energetic"] },
  screamo: { energy: 0.9, valence: 0.3, acoustic: 0.03, moods: ["aggressive", "dark"] },
  grindcore: { energy: 0.98, valence: 0.3, acoustic: 0.02, moods: ["aggressive", "scary"] },
  grunge: { energy: 0.75, valence: 0.4, acoustic: 0.15, moods: ["aggressive", "dark"] },
  emo: { energy: 0.7, valence: 0.35, acoustic: 0.2, moods: ["sad", "energetic"] },
  stoner: { energy: 0.7, valence: 0.5, acoustic: 0.15, moods: ["dark", "energetic"] },
  sludge: { energy: 0.65, valence: 0.25, acoustic: 0.1, moods: ["dark", "aggressive"] },
  industrial: { energy: 0.8, valence: 0.35, acoustic: 0.02, moods: ["dark", "aggressive"] },
  noise: { energy: 0.7, valence: 0.25, acoustic: 0.05, moods: ["scary", "aggressive"] },
  trance: { energy: 0.85, valence: 0.65, acoustic: 0.02, moods: ["energetic", "uplifting"] },
  dubstep: { energy: 0.85, valence: 0.5, acoustic: 0.02, moods: ["energetic", "dark"] },
  edm: { energy: 0.85, valence: 0.7, acoustic: 0.02, moods: ["energetic", "uplifting"] },
  trap: { energy: 0.75, valence: 0.5, acoustic: 0.05, moods: ["energetic", "dark"] },
  drill: { energy: 0.75, valence: 0.4, acoustic: 0.05, moods: ["dark", "aggressive"] },
  grime: { energy: 0.8, valence: 0.5, acoustic: 0.05, moods: ["aggressive", "energetic"] },
  "k-pop": { energy: 0.8, valence: 0.8, acoustic: 0.08, moods: ["happy", "energetic"] },
  "j-pop": { energy: 0.78, valence: 0.8, acoustic: 0.1, moods: ["happy", "uplifting"] },
  "new wave": { energy: 0.7, valence: 0.65, acoustic: 0.08, moods: ["energetic", "happy"] },
  synthpop: { energy: 0.7, valence: 0.7, acoustic: 0.05, moods: ["happy", "energetic"] },
  "synth-pop": { energy: 0.7, valence: 0.7, acoustic: 0.05, moods: ["happy", "energetic"] },
  reggaeton: { energy: 0.8, valence: 0.75, acoustic: 0.05, moods: ["sexy", "energetic"] },
  latin: { energy: 0.75, valence: 0.75, acoustic: 0.3, moods: ["happy", "energetic"] },
  salsa: { energy: 0.8, valence: 0.8, acoustic: 0.4, moods: ["happy", "energetic"] },
  cumbia: { energy: 0.65, valence: 0.75, acoustic: 0.4, moods: ["happy"] },
  afrobeat: { energy: 0.75, valence: 0.75, acoustic: 0.3, moods: ["happy", "energetic"] },
  ska: { energy: 0.8, valence: 0.75, acoustic: 0.15, moods: ["happy", "energetic"] },
  surf: { energy: 0.7, valence: 0.7, acoustic: 0.2, moods: ["happy", "energetic"] },
  "math rock": { energy: 0.75, valence: 0.55, acoustic: 0.2, moods: ["energetic"] },

  // ── mid / groovy → pace dead zone (0.4 < energy < 0.7 = no nudge) ────
  "r&b": { energy: 0.55, valence: 0.6, acoustic: 0.2, moods: ["sexy", "chilled"] },
  soul: { energy: 0.55, valence: 0.65, acoustic: 0.25, moods: ["romantic", "uplifting"] },
  reggae: { energy: 0.6, valence: 0.75, acoustic: 0.2, moods: ["chilled", "happy"] },
  indie: { energy: 0.6, valence: 0.55, acoustic: 0.3, moods: ["chilled"] },
  alternative: { energy: 0.65, valence: 0.5, acoustic: 0.2, moods: ["energetic"] },
  progressive: { energy: 0.65, valence: 0.5, acoustic: 0.15, moods: ["epic"] },
  psychedelic: { energy: 0.6, valence: 0.55, acoustic: 0.3, moods: ["ethereal"] },
  krautrock: { energy: 0.6, valence: 0.5, acoustic: 0.2, moods: ["ethereal", "energetic"] },
  synthwave: { energy: 0.65, valence: 0.55, acoustic: 0.02, moods: ["energetic", "ethereal"] },
  "city pop": { energy: 0.6, valence: 0.7, acoustic: 0.3, moods: ["happy", "chilled"] },
  garage: { energy: 0.75, valence: 0.6, acoustic: 0.1, moods: ["energetic"] },
  country: { energy: 0.55, valence: 0.6, acoustic: 0.7, moods: ["happy", "romantic"] },
  bluegrass: { energy: 0.65, valence: 0.7, acoustic: 0.9, moods: ["happy", "uplifting"] },
  americana: { energy: 0.45, valence: 0.5, acoustic: 0.8, moods: ["calm", "romantic"] },
  gospel: { energy: 0.6, valence: 0.8, acoustic: 0.6, moods: ["uplifting", "epic"] },
  swing: { energy: 0.65, valence: 0.75, acoustic: 0.6, moods: ["happy"] },
  "big band": { energy: 0.65, valence: 0.7, acoustic: 0.6, moods: ["happy", "epic"] },
  samba: { energy: 0.7, valence: 0.8, acoustic: 0.5, moods: ["happy"] },
  flamenco: { energy: 0.6, valence: 0.5, acoustic: 0.85, moods: ["romantic", "epic"] },

  // ── low energy, organic → pace low, tone warm ────────────────────────
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
  "dream pop": { energy: 0.45, valence: 0.5, acoustic: 0.3, moods: ["ethereal", "chilled"] },
  "bedroom pop": { energy: 0.45, valence: 0.55, acoustic: 0.3, moods: ["chilled"] },
  vaporwave: { energy: 0.35, valence: 0.45, acoustic: 0.1, moods: ["ethereal", "chilled"] },
  idm: { energy: 0.55, valence: 0.45, acoustic: 0.05, moods: ["ethereal"] },
  "bossa nova": { energy: 0.35, valence: 0.6, acoustic: 0.7, moods: ["chilled", "romantic"] },
  "new age": { energy: 0.2, valence: 0.6, acoustic: 0.7, moods: ["calm", "ethereal"] },
  soundtrack: { energy: 0.45, valence: 0.45, acoustic: 0.6, moods: ["epic"] },
  opera: { energy: 0.5, valence: 0.45, acoustic: 0.9, moods: ["epic"] },
  choral: { energy: 0.3, valence: 0.5, acoustic: 0.95, moods: ["ethereal", "epic"] },

  // ── low energy, low valence → pace low; dark moods are render-only ───
  //    (valence currently moves NO dial — see BACKLOG "energyToMode boundary")
  blues: { energy: 0.45, valence: 0.35, acoustic: 0.5, moods: ["sad", "dark"] },
  goth: { energy: 0.55, valence: 0.3, acoustic: 0.2, moods: ["dark"] },
  gothic: { energy: 0.55, valence: 0.3, acoustic: 0.2, moods: ["dark"] },
  darkwave: { energy: 0.6, valence: 0.35, acoustic: 0.1, moods: ["dark", "ethereal"] },
  drone: { energy: 0.15, valence: 0.3, acoustic: 0.4, moods: ["dark", "ethereal"] },
  slowcore: { energy: 0.25, valence: 0.3, acoustic: 0.5, moods: ["sad", "dark"] },
  sad: { energy: 0.3, valence: 0.2, acoustic: 0.5, moods: ["sad"] },
  melancholy: { energy: 0.3, valence: 0.25, acoustic: 0.5, moods: ["sad", "dark"] },
  melancholic: { energy: 0.3, valence: 0.25, acoustic: 0.5, moods: ["sad", "dark"] },
  doom: { energy: 0.5, valence: 0.2, acoustic: 0.2, moods: ["dark", "scary"] },
};

export interface Vibe {
  moods: Mood[]; // 2–4 clean adjectives, ordered by salience
  energy: number; // averaged 0–1 — feeds the pace + posture dials in cadence.ts
  valence: number; // averaged 0–1 — positiveness, colors the mood words
  acoustic: number; // averaged 0–1 — organic/acoustic-ness → warms the tone dial
}

// Keys sorted longest-first so the most SPECIFIC row wins per tag: a
// "post-rock" tag must hit the post-rock row, never fall through to "rock".
// (Insertion-order matching silently mis-filed every sub-genre whose parent
// appeared earlier in the table.)
const GENRE_KEYS = Object.keys(GENRE_AFFECT).sort((a, b) => b.length - a.length);

/** Match a list of raw tags against the affect table and aggregate. */
export function tagsToVibe(tags: string[]): Vibe | null {
  const hits: Affect[] = [];
  for (const raw of tags) {
    const t = raw.toLowerCase();
    for (const key of GENRE_KEYS) {
      if (t.includes(key)) {
        hits.push(GENRE_AFFECT[key]!);
        break; // one row per tag — the longest (most specific) match wins
      }
    }
  }
  if (hits.length === 0) return null;

  const avg = (pick: (a: Affect) => number) =>
    hits.reduce((s, a) => s + pick(a), 0) / hits.length;
  const energy = avg((a) => a.energy);
  const valence = avg((a) => a.valence);
  const acoustic = avg((a) => a.acoustic);

  // Mood words: collect from all hits, dedupe, keep most frequent first.
  const moodCounts = new Map<Mood, number>();
  for (const h of hits) for (const m of h.moods) {
    moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1);
  }
  const moods = [...moodCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([m]) => m);

  return { moods, energy, valence, acoustic };
}
