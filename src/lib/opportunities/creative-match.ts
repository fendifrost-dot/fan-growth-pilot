// Opportunity Engine — creative matching (deterministic).
//
// Scores how well a song's intelligence profile fits an entity's stated taste
// (genre / mood tags carried on the entity metadata). This seeds the
// audience_match component. It is a transparent tag-overlap heuristic, NOT an
// embedding model — Phase 2 can replace the internals without changing callers.

import type { EntityMatchLike, SongProfileLike } from "./types.ts";
import { normalizeText } from "./normalization.ts";

function tagSet(tags?: string[] | null): Set<string> {
  return new Set((tags ?? []).map((t) => normalizeText(t)).filter(Boolean));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits += 1;
  // Jaccard-ish: hits over the smaller set, so a focused entity matching any of
  // the song's genres scores well without being diluted by a huge tag list.
  return hits / Math.min(a.size, b.size);
}

export interface CreativeMatch {
  /** 0..1 fit used to seed audience_match_score. */
  fit: number;
  reasons: string[];
}

/**
 * Combine genre overlap (primary) and mood overlap (secondary). Returns a neutral
 * 0.5 with an explicit reason when there is no profile/tag data to compare, so we
 * never fabricate a confident match from nothing.
 */
export function creativeMatch(
  song: SongProfileLike | null | undefined,
  entity: EntityMatchLike | null | undefined,
): CreativeMatch {
  const meta = (entity?.metadata ?? {}) as Record<string, unknown>;
  const entityGenres = tagSet(meta.genre_tags as string[] | undefined);
  const entityMoods = tagSet(meta.mood_tags as string[] | undefined);

  const songGenres = tagSet(song?.genre_tags);
  const songMoods = tagSet(song?.mood_tags);

  if ((entityGenres.size === 0 && entityMoods.size === 0) ||
      (songGenres.size === 0 && songMoods.size === 0)) {
    return { fit: 0.5, reasons: ["no genre/mood data on both sides — neutral fit"] };
  }

  const genreFit = overlap(songGenres, entityGenres);
  const moodFit = overlap(songMoods, entityMoods);
  const fit = Math.min(1, 0.7 * genreFit + 0.3 * moodFit);

  const reasons: string[] = [];
  if (genreFit > 0) reasons.push(`genre overlap ${(genreFit * 100).toFixed(0)}%`);
  if (moodFit > 0) reasons.push(`mood overlap ${(moodFit * 100).toFixed(0)}%`);
  if (reasons.length === 0) reasons.push("no tag overlap");

  return { fit: Math.round(fit * 1000) / 1000, reasons };
}
