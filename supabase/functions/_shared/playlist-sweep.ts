/**
 * playlist-sweep — pure, testable scoring + classification for the mass
 * rap/house discovery sweep.
 *
 * Two independent concerns, both dependency-light so they unit-test without
 * booting the edge function:
 *   1. `computeBotRisk` — 0-100 de-botting score from named-constant heuristics.
 *   2. `classifyFeel`   — mood/feel bucket from name + description + genre terms.
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
export function computeBotRisk(pl: PlaylistSignal): { bot_risk: number; reasons: string[] } {
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

/** Ordered so ties resolve deterministically toward the more specific mood. */
export const FEEL_CATEGORIES = [
  "hype",
  "gym_workout",
  "party_house",
  "late_night_chill",
  "introspective",
  "feel_good",
] as const;

export type FeelCategory = (typeof FEEL_CATEGORIES)[number] | "uncategorized";

// Keyword → category. Matched as word-ish substrings against a lowercased
// haystack of name + description + genre terms. Kept as plain arrays so new
// vocabulary is a one-line edit.
const FEEL_KEYWORDS: Record<(typeof FEEL_CATEGORIES)[number], string[]> = {
  hype: [
    "hype", "turnt", "turn up", "banger", "bangers", "rage", "mosh", "aggressive",
    "gym rap", "rap hits", "trap nation", "adrenaline", "energy", "hard", "savage",
    "drill", "opp", "beast mode",
  ],
  gym_workout: [
    "gym", "workout", "training", "run", "running", "cardio", "lift", "lifting",
    "pump", "pre workout", "pre-workout", "hiit", "fitness", "sweat", "power",
  ],
  party_house: [
    "party", "club", "dance", "dancefloor", "rave", "festival", "bass house",
    "tech house", "afro house", "peak time", "warehouse", "friday", "weekend",
    "bangers only", "night out", "edm",
  ],
  late_night_chill: [
    "chill", "late night", "lofi", "lo-fi", "lo fi", "night drive", "midnight",
    "relax", "mellow", "smooth", "slow", "vibe", "vibes", "downtempo", "deep house",
    "soulful", "after hours", "unwind", "lounge", "sunset",
  ],
  introspective: [
    "introspective", "conscious", "deep", "thoughtful", "reflect", "reflective",
    "sad", "melancholy", "emo", "in my feelings", "alone", "rainy", "storytelling",
    "boom bap", "lyrical", "poetry", "soul searching",
  ],
  feel_good: [
    "feel good", "feelgood", "happy", "good vibes", "positive", "uplifting",
    "sunshine", "summer", "groove", "groovy", "soul", "funky", "warm", "bright",
    "smile", "wholesome",
  ],
};

/** Minimum share of matched weight required to commit to a category. */
export const FEEL_MIN_CONFIDENCE = 0.34;

/**
 * Bucket a playlist into a mood/feel category from its name, description and any
 * genre terms. Returns the winning category with a confidence in [0, 1]. Falls
 * back to `uncategorized` (confidence 0) rather than guessing when nothing
 * meaningful matches or the leader is too weak to trust.
 */
export function classifyFeel(
  name: string | null | undefined,
  description: string | null | undefined,
  genreTerms: string[] = [],
): { category: FeelCategory; confidence: number } {
  const haystack = [name ?? "", description ?? "", ...genreTerms]
    .join(" ")
    .toLowerCase();
  if (!haystack.trim()) return { category: "uncategorized", confidence: 0 };

  const scores: Record<string, number> = {};
  let total = 0;
  for (const cat of FEEL_CATEGORIES) {
    let hits = 0;
    for (const kw of FEEL_KEYWORDS[cat]) {
      if (haystack.includes(kw)) hits++;
    }
    scores[cat] = hits;
    total += hits;
  }

  if (total === 0) return { category: "uncategorized", confidence: 0 };

  // FEEL_CATEGORIES order breaks ties toward the earlier (more specific) mood.
  let best: (typeof FEEL_CATEGORIES)[number] = FEEL_CATEGORIES[0];
  for (const cat of FEEL_CATEGORIES) {
    if (scores[cat] > scores[best]) best = cat;
  }

  const confidence = scores[best] / total;
  if (confidence < FEEL_MIN_CONFIDENCE) {
    return { category: "uncategorized", confidence: Number(confidence.toFixed(3)) };
  }
  return { category: best, confidence: Number(confidence.toFixed(3)) };
}

/** research_context.source tag for rows ingested by this sweep. */
export const SWEEP_SOURCE = "mass_sweep_rap_house";
