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
