/**
 * playlist-sweep — pure, testable scoring + classification for the mass
 * rap/house discovery sweep.
 *
 * Two independent concerns, both dependency-light so they unit-test without
 * booting the edge function:
 *   1. `computeBotRisk` — 0-100 de-botting score from named-constant heuristics.
 *   2. `classifyFeel`   — mood/feel bucket from name + description + track artists
 *      + track titles. Genre/subgenre + artist cues let it label rap/house
 *      playlists whose NAME announces no mood, falling back to a neutral
 *      `rap_general`/`house_general` (never a mood the data doesn't evidence) and
 *      only to `uncategorized` when there's truly no signal.
 *
 * NOTE (reuse): there is no pre-existing computed fraud/legitimacy scorer in the
 * codebase — every `fraud_score`/`fraud_verdict` write elsewhere is a hardcoded
 * constant. `bot_risk` is discovery-time playlist-legitimacy scoring, distinct
 * from (and complementary to) that static `fraud_score` default. The Spotify
 * editorial/owned detection is reused from curator-filters.ts, not re-implemented.
 */
import { isSpotifyOwnedCurator, normalizeCuratorName } from "./curator-filters.ts";

/** Everything the bot scorer + feel classifier can read off a discovered playlist. */
export type PlaylistSignal = {
  playlist_id?: string | null;
  name?: string | null;
  description?: string | null;
  /** Curator/owner display name. */
  owner?: string | null;
  owner_id?: string | null;
  /** Followers/saves. */
  followers?: number | null;
  /** Track count, when the detail scrape surfaced it (often null). */
  track_count?: number | null;
  /**
   * Whether the detail scrape actually populated this row's metadata.
   * `false` means enrichment was never attempted or failed (SPA didn't render,
   * budget expired, scrape errored) — the name/owner/description are ABSENT, not
   * evidence of a bot. `true` means we have real data to score. `undefined`
   * (legacy callers that always pass real data) is treated as enriched.
   */
  enriched?: boolean;
};

// ---------------------------------------------------------------------------
// bot_risk — de-botting score
// ---------------------------------------------------------------------------

/**
 * Per-heuristic point values. Summed then clamped to [0, 100]. Named so the
 * weighting is auditable and trivially tunable — no magic numbers inline.
 */
export const BOT_RISK_POINTS = {
  /** Spotify editorial id prefix (37i9dQZF…) — algorithmic, no human to pitch. */
  EDITORIAL_PREFIX: 60,
  /** Owner is a Spotify-owned brand (Spotify/Filtr/Topsify/Digster/…). */
  SPOTIFY_OWNER: 55,
  /** No curator/owner identity at all — nobody to build a relationship with. */
  MISSING_IDENTITY: 25,
  /** Generic auto-generated-looking name ("Playlist ab12cd", "My Playlist #3"). */
  GENERIC_NAME: 20,
  /** Empty or boilerplate description. */
  EMPTY_DESCRIPTION: 10,
  /** Implausible follower:track ratio (huge saves, a handful of tracks). */
  IMPLAUSIBLE_RATIO: 20,
  /** Follower count internally inconsistent (e.g. big followers, zero tracks). */
  FOLLOWER_INCONSISTENT: 15,
} as const;

/**
 * Playlists scoring at or above this are excluded from the sweep by default.
 * Set at 70 so a single strong red flag alone doesn't nuke a real curator —
 * editorial-prefix (60) or Spotify-owner (55) each clears it only when paired
 * with a second flag OR is caught by the editorial/owner filters upstream. It
 * takes a genuine cluster of weaker signals (missing identity 25 + generic name
 * 20 + implausible ratio 20 + empty desc 10 = 75) to cross on heuristics alone.
 */
export const BOT_RISK_THRESHOLD = 70;

// Names that read as machine-generated rather than curated.
const GENERIC_NAME_PATTERNS: RegExp[] = [
  /^playlist\s*[#]?\s*[a-z0-9]{0,8}$/i,
  /^my playlist(\s*[#]?\s*\d+)?$/i,
  /^new playlist(\s*[#]?\s*\d+)?$/i,
  /^untitled(\s*playlist)?(\s*[#]?\s*\d+)?$/i,
  /^liked songs$/i,
  /^[a-f0-9]{16,}$/i, // raw hash/id as a name
];

// Descriptions that carry no curator voice.
const BOILERPLATE_DESC_PATTERNS: RegExp[] = [
  /^a playlist by spotify$/i,
  /^cover:/i,
  /^\s*$/,
];

function isEditorialId(playlistId: string | null | undefined): boolean {
  const id = (playlistId ?? "").replace(/^spotify:/, "");
  return /^37i9dQZF/i.test(id);
}

/**
 * Score a discovered playlist 0-100 for how bot-like / un-pitchable it looks.
 * Higher = riskier. Returns the score plus the named reasons that fired so the
 * verdict is explainable in logs and the admin UI. Never throws on partial data
 * — heuristics whose inputs are missing simply contribute nothing.
 */
export function computeBotRisk(pl: PlaylistSignal): { bot_risk: number | null; reasons: string[] } {
  // Enrichment never happened → we have no metadata to judge. Scoring here would
  // fire missing_identity + empty_description (and any follower/track-ratio check)
  // on EVERY un-enriched row — a false ~35 that isn't a bot signal, it's the
  // absence of data. Defer: bot_risk is pending until a later run enriches the row.
  // (`enriched === false` is explicit; `undefined` keeps legacy scoring for callers
  // that only ever pass real data.)
  if (pl.enriched === false) {
    return { bot_risk: null, reasons: ["enrichment_pending"] };
  }

  const reasons: string[] = [];
  let score = 0;
  const add = (pts: number, reason: string) => {
    score += pts;
    reasons.push(reason);
  };

  const name = (pl.name ?? "").trim();
  const desc = (pl.description ?? "").trim();
  const owner = (pl.owner ?? "").trim();
  const followers = pl.followers;
  const tracks = pl.track_count;

  // Spotify editorial / owned — the strongest signals.
  if (isEditorialId(pl.playlist_id)) add(BOT_RISK_POINTS.EDITORIAL_PREFIX, "editorial_prefix");
  else if (isSpotifyOwnedCurator(owner || null, name || null, pl.playlist_id ?? null)) {
    add(BOT_RISK_POINTS.SPOTIFY_OWNER, "spotify_owner");
  }

  // Missing curator identity — no owner name AND no owner id.
  if (!normalizeCuratorName(owner) && !(pl.owner_id ?? "").trim()) {
    add(BOT_RISK_POINTS.MISSING_IDENTITY, "missing_identity");
  }

  // Generic / auto-generated name.
  if (name && GENERIC_NAME_PATTERNS.some((re) => re.test(name))) {
    add(BOT_RISK_POINTS.GENERIC_NAME, "generic_name");
  }

  // Empty or boilerplate description.
  if (!desc || BOILERPLATE_DESC_PATTERNS.some((re) => re.test(desc))) {
    add(BOT_RISK_POINTS.EMPTY_DESCRIPTION, "empty_or_boilerplate_description");
  }

  // Engagement/size consistency — only when we actually have the numbers.
  if (typeof followers === "number" && typeof tracks === "number") {
    if (tracks === 0 && followers > 100) {
      add(BOT_RISK_POINTS.FOLLOWER_INCONSISTENT, "followers_without_tracks");
    } else if (tracks > 0 && followers / Math.max(1, tracks) > 5000) {
      // e.g. 500k followers over 12 tracks — inflated saves relative to content.
      add(BOT_RISK_POINTS.IMPLAUSIBLE_RATIO, "implausible_follower_track_ratio");
    }
  }

  return { bot_risk: Math.max(0, Math.min(100, score)), reasons };
}

// ---------------------------------------------------------------------------
// Feel classifier
// ---------------------------------------------------------------------------

/** The six evidenced MOOD buckets. Ordered so ties resolve deterministically
 * toward the earlier (more specific) mood. */
export const FEEL_CATEGORIES = [
  "hype",
  "gym_workout",
  "party_house",
  "late_night_chill",
  "introspective",
  "feel_good",
] as const;

/**
 * Neutral genre buckets. Chosen when a playlist is clearly rap (or house) but the
 * data doesn't evidence any one mood — a deliberate "this is rap, mood unknown"
 * rather than forcing a wrong mood (the bug where a generic "Hip Hop: Essentials"
 * landed in `late_night_chill`). Better than `uncategorized`, which is reserved
 * for playlists with no usable signal at all.
 */
export const NEUTRAL_CATEGORIES = ["rap_general", "house_general"] as const;

export type MoodCategory = (typeof FEEL_CATEGORIES)[number];
export type FeelCategory =
  | MoodCategory
  | (typeof NEUTRAL_CATEGORIES)[number]
  | "uncategorized";

export type FeelResult = {
  category: FeelCategory;
  confidence: number;
  /** Short, human-readable note on what matched — for debugging misclassifications
   * from the response body / row without re-running the classifier. */
  reason: string;
};

// Mood vocabulary, split by strength. `strong` cues are genre/subgenre or
// mood-defining terms (trap, drill, deep house, after hours) that are worth
// double weight; `soft` cues are weaker mood words. Matched as whole words
// (see `hasTerm`) against name / description / track text. Plain arrays so new
// vocabulary is a one-line edit.
const FEEL_LEXICON: Record<MoodCategory, { strong: string[]; soft: string[] }> = {
  hype: {
    strong: [
      "trap", "drill", "phonk", "rage", "plugg", "crunk", "hyphy", "mosh",
      "beast mode", "turnt", "trap nation", "gym rap", "rap hits",
    ],
    soft: [
      "hype", "turn up", "banger", "bangers", "aggressive", "adrenaline",
      "energy", "hard", "savage", "opp", "opps", "808", "hype rap",
    ],
  },
  gym_workout: {
    strong: ["gym", "workout", "pre workout", "pre-workout", "hiit", "cardio"],
    soft: [
      "training", "run", "running", "lift", "lifting", "pump", "fitness",
      "sweat", "grind", "motivation",
    ],
  },
  party_house: {
    // Party/club CONTEXT cues only. Bare house SUBGENRES (tech house, bass house,
    // afro house, future house, electro house, big room, edm) were removed — they
    // are genre names, not a party mood, and were labeling genre-only house
    // playlists party_house. They now feed the neutral house_general bucket
    // (HOUSE_GENRE_CUES); a row commits to party_house only on an actual
    // party/club/rave/festival cue.
    strong: [
      "peak time", "rave", "festival",
    ],
    soft: [
      "party", "club", "dance", "dancefloor", "warehouse", "night out",
      "bangers only", "friday", "weekend", "twerk",
    ],
  },
  late_night_chill: {
    // Genuine chill signal ONLY — never house/genre names. "deep house" and
    // "soulful house" were removed: they are GENRE tokens, not moods, and were
    // forcing bare "DEEP HOUSE - TOP 50" / "Deep House 2026" into late_night_chill.
    // Genre detection now routes those to house_general (see HOUSE_GENRE_CUES); a
    // row lands here only on a real chill cue (lofi, sleep, study, mellow, rainy,
    // lounge, "late night", "chill", …).
    strong: [
      "lofi", "lo-fi", "lo fi", "downtempo", "after hours", "late night",
      "chillhop", "sleep", "sleepy", "study", "study beats",
    ],
    soft: [
      "chill", "night drive", "midnight", "relax", "mellow", "rainy", "unwind",
      "lounge", "sunset", "smooth", "slow", "vibe", "vibes", "cruise",
    ],
  },
  introspective: {
    strong: [
      "boom bap", "boom-bap", "conscious", "lyrical", "storytelling",
      "cloud rap", "emo rap", "real hip hop",
    ],
    soft: [
      "introspective", "thoughtful", "reflect", "reflective", "sad", "melancholy",
      "emo", "in my feelings", "alone", "rainy", "poetry", "soul searching",
    ],
  },
  feel_good: {
    strong: ["feel good", "feelgood", "good vibes", "afrobeat", "afrobeats", "amapiano"],
    soft: [
      "happy", "positive", "uplifting", "sunshine", "summer", "groove", "groovy",
      "funky", "warm", "bright", "smile", "wholesome",
    ],
  },
};

// Genre cues — used only for the neutral rap_general / house_general fallback when
// no mood clears the bar. Deliberately broad (they overlap the mood lexicon; that's
// fine — genre detection is a separate pass from mood scoring).
const RAP_GENRE_CUES = [
  "rap", "hip hop", "hip-hop", "hiphop", "trap", "drill", "boom bap", "boom-bap",
  "phonk", "plugg", "grime", "gangsta", "gangster", "crunk", "cypher", "freestyle",
  "g-funk", "g funk", "west coast", "east coast", "dirty south", "underground rap",
  "rap music", "rappers",
];
const HOUSE_GENRE_CUES = [
  "house", "techno", "edm", "electronic", "disco", "garage", "amapiano",
  "afro house", "tech house", "deep house", "bass house", "big room",
  "future house", "electro house", "soulful house", "top 50",
];

// Well-known artist → mood cue. A single match is a modest nudge (track-zone
// weight); several trap names together push a "Hip Hop Rotation" to `hype`, several
// lyricists push it to `introspective`. Curated + distinctive to avoid false hits.
const ARTIST_FEEL: Array<[string, MoodCategory]> = [
  ["playboi carti", "hype"], ["travis scott", "hype"], ["lil uzi vert", "hype"],
  ["ski mask", "hype"], ["chief keef", "hype"], ["pop smoke", "hype"],
  ["21 savage", "hype"], ["gunna", "hype"], ["lil baby", "hype"],
  ["megan thee stallion", "hype"], ["trippie redd", "hype"], ["ken carson", "hype"],
  ["destroy lonely", "hype"], ["yeat", "hype"], ["sheck wes", "hype"],
  ["kendrick lamar", "introspective"], ["j. cole", "introspective"],
  ["joey bada", "introspective"], ["mac miller", "introspective"],
  ["isaiah rashad", "introspective"], ["earl sweatshirt", "introspective"],
  ["mick jenkins", "introspective"], ["little simz", "introspective"],
  ["fisher", "party_house"], ["john summit", "party_house"], ["chris lake", "party_house"],
  ["dom dolla", "party_house"], ["disclosure", "party_house"], ["black coffee", "late_night_chill"],
];

/** Per-zone weight: the name is the strongest evidence, then description, then the
 * (noisier) track artist/title text. */
const ZONE_WEIGHTS = { name: 3, description: 2, tracks: 1 } as const;
const STRONG_W = 2;
const SOFT_W = 1;

/** Minimum share of matched weight required to commit to a mood category. */
export const FEEL_MIN_CONFIDENCE = 0.34;
/** Absolute weighted-score floor to commit to a mood — a lone weak word (a single
 * soft cue in the description = 2) stays below this, so it can't hijack the label
 * (this is the guard against "one stray word → wrong mood"). A name cue (3), a
 * strong cue (≥4), or two hits clear it. */
const MIN_MOOD_SCORE = 3;
/** Confidence reported for a neutral genre bucket — deliberately low: we're
 * confident about the genre, not about a mood. */
const NEUTRAL_CONFIDENCE = 0.25;

/**
 * Cues too generic to DEFINE a mood on their own. They still contribute to a
 * category's score, but a category whose matches are ALL weak modifiers won't
 * commit — the guard against a lone "slow"/"vibe" in a name forcing
 * late_night_chill at confidence 1 (e.g. "Deep House 2026" whose only chill token
 * is "slow" must resolve to house_general, not late_night_chill).
 */
const WEAK_MOOD_CUES = new Set(["slow", "smooth", "vibe", "vibes", "cruise"]);

/**
 * Version stamp for the classifier's logic + lexicon. Persisted on each classified
 * row so a later sweep can detect rows labeled by an OLDER build and re-run them
 * (the fix for stale labels frozen at whatever the classifier knew the day the row
 * was ingested). BUMP whenever classifyFeel's lexicon, weights, thresholds, weak-cue
 * set, or resolution order changes — otherwise stale rows won't be recognized as
 * stale and won't be re-classified.
 *   v1 → original lexicon.
 *   v2 → genre subtokens (deep/tech house, edm, …) removed from mood lexicons and
 *        routed to house_general; weak-modifier guard added; "top 50" house cue.
 */
export const CLASSIFIER_VERSION = 2;

/**
 * True when a row's stored classifier version is older than — or missing versus —
 * the current CLASSIFIER_VERSION, i.e. it was labeled by an older build and must be
 * re-classified. A null/empty/non-numeric stamp is treated as stale: those are the
 * pre-version rows (the `reason=None` mislabels) that never got a version at all.
 * Pure + exported so the sweep's re-classify guard and its unit test share one rule.
 */
export function isClassifierStale(stored: number | string | null | undefined): boolean {
  if (stored === null || stored === undefined || stored === "") return true;
  const v = typeof stored === "number" ? stored : Number(stored);
  if (!Number.isFinite(v)) return true;
  return v < CLASSIFIER_VERSION;
}

/** Verdict for a single enrichment attempt. */
export type EnrichVerdict = { enriched: boolean; dead: boolean; reason?: string };

/**
 * Pure verdict for one playlist enrichment attempt — shared by the edge function's
 * detail-scrape handler and its unit tests, so "what counts as dead" is defined once.
 *   - real name recovered      → enriched (counts as backfilled_ok)
 *   - entity but no real name   → NOT enriched, retryable ("no_name") — a transient
 *                                 render miss worth one more try, NOT dead
 *   - no entity at all          → NOT enriched, DEAD ("no_metadata"): the embed +
 *                                 oEmbed both returned nothing → the playlist is
 *                                 deleted/private/region-locked. Never backfilled_ok;
 *                                 excluded from future retries.
 */
export function enrichmentOutcome(hasEntity: boolean, hasRealName: boolean): EnrichVerdict {
  if (hasRealName) return { enriched: true, dead: false };
  if (hasEntity) return { enriched: false, dead: false, reason: "no_name" };
  return { enriched: false, dead: true, reason: "no_metadata" };
}

/** Whole-word-ish match: `term` (already lowercased) bounded by non-alphanumerics.
 * Guards against short cues like "808"/"run" matching inside longer tokens, and
 * handles multi-word/hyphenated cues ("deep house", "lo-fi"). */
function hasTerm(haystack: string, term: string): boolean {
  if (!haystack || !term) return false;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Bucket a playlist into a mood/feel category from every signal we have: its name,
 * description, and the embed-derived track artists + track titles. Rap/house
 * playlists rarely announce a mood in the name, so the classifier also reads
 * genre/subgenre cues and known artist names.
 *
 * Resolution order (conservative by design):
 *   1. A MOOD wins only if its weighted score clears both an absolute floor
 *      (`MIN_MOOD_SCORE`) and a dominance share (`FEEL_MIN_CONFIDENCE`) — so a lone
 *      stray word can't force a mood the data doesn't support.
 *   2. Else, if the text is clearly rap or house, return the neutral
 *      `rap_general` / `house_general` bucket (NOT a guessed mood).
 *   3. Else `uncategorized`.
 *
 * `artists`/`titles` default to `[]` so the legacy 3-arg call site (and tests)
 * that passed only genre terms as the 3rd arg keep working.
 */
export function classifyFeel(
  name: string | null | undefined,
  description: string | null | undefined,
  artists: string[] = [],
  titles: string[] = [],
): FeelResult {
  const nameText = (name ?? "").toLowerCase();
  const descText = (description ?? "").toLowerCase();
  const artistText = artists.join(" ").toLowerCase();
  const trackText = [...artists, ...titles].join(" ").toLowerCase();
  const zones = [
    { text: nameText, w: ZONE_WEIGHTS.name },
    { text: descText, w: ZONE_WEIGHTS.description },
    { text: trackText, w: ZONE_WEIGHTS.tracks },
  ];
  const allText = `${nameText} ${descText} ${trackText}`;
  if (!allText.trim()) return { category: "uncategorized", confidence: 0, reason: "no signal" };

  const scores: Record<MoodCategory, number> = {
    hype: 0, gym_workout: 0, party_house: 0, late_night_chill: 0, introspective: 0, feel_good: 0,
  };
  const matched: Record<MoodCategory, Set<string>> = {
    hype: new Set(), gym_workout: new Set(), party_house: new Set(),
    late_night_chill: new Set(), introspective: new Set(), feel_good: new Set(),
  };

  for (const cat of FEEL_CATEGORIES) {
    for (const zone of zones) {
      if (!zone.text) continue;
      for (const kw of FEEL_LEXICON[cat].strong) {
        if (hasTerm(zone.text, kw)) { scores[cat] += zone.w * STRONG_W; matched[cat].add(kw); }
      }
      for (const kw of FEEL_LEXICON[cat].soft) {
        if (hasTerm(zone.text, kw)) { scores[cat] += zone.w * SOFT_W; matched[cat].add(kw); }
      }
    }
  }

  // Artist-name cues (track-zone weight, strong): matched as substrings of the
  // artist list only (never titles) to keep famous common-word names in check.
  for (const [needle, cat] of ARTIST_FEEL) {
    if (artistText.includes(needle)) {
      scores[cat] += ZONE_WEIGHTS.tracks * STRONG_W;
      matched[cat].add(`@${needle}`);
    }
  }

  let total = 0;
  for (const cat of FEEL_CATEGORIES) total += scores[cat];
  let best: MoodCategory = FEEL_CATEGORIES[0];
  for (const cat of FEEL_CATEGORIES) {
    if (scores[cat] > scores[best]) best = cat;
  }
  const bestScore = scores[best];
  const share = total > 0 ? bestScore / total : 0;

  // 1) Commit to a mood only when it's strong enough, dominant enough, AND the
  //    winning category matched at least one cue that isn't a bare weak modifier —
  //    a lone "slow"/"vibe" can't force a mood the data doesn't really evidence.
  const bestMatches = [...matched[best]];
  const hasDefiningCue = bestMatches.some((t) => !WEAK_MOOD_CUES.has(t));
  if (bestScore >= MIN_MOOD_SCORE && share >= FEEL_MIN_CONFIDENCE && hasDefiningCue) {
    const terms = bestMatches.slice(0, 4).join(", ");
    return { category: best, confidence: Number(share.toFixed(3)), reason: `${best}: ${terms}` };
  }

  // 2) No evidenced mood, but the genre is clear → neutral bucket, not a guess.
  const isRap = RAP_GENRE_CUES.some((c) => hasTerm(allText, c));
  const isHouse = HOUSE_GENRE_CUES.some((c) => hasTerm(allText, c));
  if (isRap || isHouse) {
    // Sweep is rap-led; on a tie (or rap-only) default to rap_general.
    const rap = isRap || !isHouse;
    const category: FeelCategory = rap ? "rap_general" : "house_general";
    const weak = bestScore > 0 ? ` (weak ${best} ${bestScore})` : "";
    return {
      category,
      confidence: NEUTRAL_CONFIDENCE,
      reason: `${rap ? "rap" : "house"} genre, no strong mood${weak}`,
    };
  }

  // 3) Genuinely no usable signal (or only sub-threshold noise with no genre).
  if (bestScore > 0) {
    return { category: "uncategorized", confidence: Number(share.toFixed(3)), reason: "weak, mixed signal" };
  }
  return { category: "uncategorized", confidence: 0, reason: "no signal" };
}

/** research_context.source tag for rows ingested by this sweep. */
export const SWEEP_SOURCE = "mass_sweep_rap_house";
