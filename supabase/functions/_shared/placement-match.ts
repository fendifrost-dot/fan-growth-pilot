// Pure helpers for the "this playlist already features this track" signal —
// the core of recommend_targets_for_track. A curator who already spun a song
// from the catalogue is the warmest possible target, so a direct placement is
// the PRIMARY ranking signal (ahead of category overlap, tier, and followers).
//
// Placement facts live in playlist_targets.research_context.featuring_tracks,
// a JSON array of song names. Two wrinkles this module handles:
//   1. Names arrive in mixed case/whitespace ("CHOOSE MY ENEMIES WISELY" vs the
//      tracks row "Choose My Enemies Wisely") — match case- and space-insensitively.
//   2. Spotify-for-Artists CSV imports seed the placeholder below instead of a
//      real song name — it must NEVER count as a placement.

/** Placeholder written by the SFA CSV importer when no real song name is known. */
export const SFA_PLACEHOLDER_TRACK = "(from Spotify for Artists playlist report)";

/** Lowercase, trim, and collapse internal whitespace for name comparison. */
export function normalizeTrackName(s: unknown): string {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const PLACEHOLDER_NORM = normalizeTrackName(SFA_PLACEHOLDER_TRACK);

/** Real featuring-track names from a row's research_context, minus the placeholder. */
export function featuringTrackNames(row: { research_context?: unknown }): string[] {
  const rc = row.research_context as Record<string, unknown> | null;
  const raw = rc?.featuring_tracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => String(t ?? "").trim())
    .filter((t) => t.length > 0 && normalizeTrackName(t) !== PLACEHOLDER_NORM);
}

/** Does this playlist already feature the given track? Case/whitespace-insensitive. */
export function placementMatch(
  row: { research_context?: unknown },
  trackName: string,
): { matched: boolean; matchedName: string | null } {
  const target = normalizeTrackName(trackName);
  if (!target) return { matched: false, matchedName: null };
  for (const f of featuringTrackNames(row)) {
    if (normalizeTrackName(f) === target) return { matched: true, matchedName: f };
  }
  return { matched: false, matchedName: null };
}

// ---------------------------------------------------------------------------
// Category gate
// ---------------------------------------------------------------------------
// The gate that decides whether a track may be pitched to a target at all.
//
// The bug this replaces: the gate required `overlap > 0` against
// playlist_categories and hard-rejected everything else. Because the verified
// target pool carries an EMPTY playlist_categories across the board, that
// rejected 27 of 31 genre-correct deep-house targets for "Designed For Me
// (Control)" and 100% of targets for "Meditate" (which has no track category at
// all) with "Category mismatch" — an empty-vs-empty comparison zeroing out the
// entire day's sends.
//
// The rule now: an ABSENT category is missing information, not a disqualifier.
// Only a POSITIVE genre contradiction rejects — i.e. both sides declare a genre
// and those genres disagree. Anything indeterminate passes and is left to the
// ranker (compareTargets) to sort, rather than being dropped from the pool.
//
// This gate is ONLY about category/genre. Pay-to-play, portal_only, declined,
// blocked, submitted and verification-status exclusions are separate gates
// (outreachPolicyBlock / isAutomatedPitchBlocked / isDraftable) and still apply.

import { SWEEP_LANE_GENRE, sweepLaneTextGenre } from "./playlist-lanes.ts";

export type Genre = "rap" | "house";

/** Genre a TARGET declares, from its stamped sweep lane first, then its own text.
 * null = no clear signal (or a contradictory one) — deliberately not a guess. */
export function targetGenre(row: {
  lane?: string | null;
  playlist_name?: string | null;
  curator_name?: string | null;
  vibe_tags?: unknown;
}): Genre | null {
  const lane = String(row.lane ?? "").trim();
  const fromLane = SWEEP_LANE_GENRE[lane];
  if (fromLane) return fromLane;
  const tags = Array.isArray(row.vibe_tags) ? row.vibe_tags.map((t) => String(t)).join(" ") : "";
  return sweepLaneTextGenre(`${row.playlist_name ?? ""} ${row.curator_name ?? ""} ${tags} ${lane}`);
}

/** Genre a TRACK declares, from its category slugs/labels first, then its own copy. */
export function trackGenre(track: {
  categories?: { slug?: string | null; label?: string | null }[];
  name?: string | null;
  short_pitch?: string | null;
  pitch_angle?: string | null;
}): Genre | null {
  const cats = (track.categories ?? []).map((c) => `${c?.slug ?? ""} ${c?.label ?? ""}`).join(" ");
  const fromCats = sweepLaneTextGenre(cats);
  if (fromCats) return fromCats;
  return sweepLaneTextGenre(`${track.name ?? ""} ${track.short_pitch ?? ""} ${track.pitch_angle ?? ""}`);
}

export type CategoryGateResult = {
  pass: boolean;
  /** Why the gate decided as it did — surfaced in the 422 body and run logs. */
  reason:
    | "category_overlap"
    | "genre_match"
    | "no_category_signal"
    | "genre_conflict";
};

/**
 * Decide the category/genre gate for one (track, target) pair.
 *
 * Passes when categories overlap, when both sides agree on genre, or when
 * either side is silent. Rejects ONLY on a positive conflict: both sides name a
 * genre and they differ (e.g. a rap track at a strictly-house target).
 */
export function categoryGate(args: {
  trackCatIds: string[];
  targetCatIds: string[];
  trackGenre: Genre | null;
  targetGenre: Genre | null;
}): CategoryGateResult {
  const overlap = args.trackCatIds.filter((id) => args.targetCatIds.includes(id));
  if (overlap.length > 0) return { pass: true, reason: "category_overlap" };

  // A genre known on BOTH sides is the only thing that can reject. Note this is
  // reached whether or not the category columns are populated — an explicitly
  // categorised target with no overlap still passes if the genre agrees.
  if (args.trackGenre && args.targetGenre) {
    return args.trackGenre === args.targetGenre
      ? { pass: true, reason: "genre_match" }
      : { pass: false, reason: "genre_conflict" };
  }

  // One or both sides silent (the empty-playlist_categories case, and the
  // "Meditate has no track category" case). Never zero out the pool on absence.
  return { pass: true, reason: "no_category_signal" };
}

/** Number of overlapping category ids — the ranking signal, not a gate. */
export function categoryOverlapCount(trackCatIds: string[], targetCatIds: string[]): number {
  return trackCatIds.filter((id) => targetCatIds.includes(id)).length;
}

/** Signals used to rank a candidate target, strongest first. */
export type RankSignal = {
  placement: boolean;
  overlap: number;
  tier: number;
  followers: number;
};

/**
 * Ranking comparator: direct placement match → category overlap → tier
 * (lower is better) → follower_count (higher is better). Returns <0 if `a`
 * should rank before `b`, so it plugs straight into Array.prototype.sort.
 */
export function compareTargets(a: RankSignal, b: RankSignal): number {
  return (Number(b.placement) - Number(a.placement)) ||
    (b.overlap - a.overlap) ||
    (a.tier - b.tier) ||
    (b.followers - a.followers);
}
