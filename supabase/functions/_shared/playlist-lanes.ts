import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type LaneConfig = {
  label?: string;
  references?: string[];
  pitch_angle?: string;
  regex_boost?: string;
};

export async function loadLanesConfig(sb: SupabaseClient): Promise<Record<string, LaneConfig>> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "lanes").maybeSingle();
  if (!data?.value || typeof data.value !== "object" || Array.isArray(data.value)) return {};
  return data.value as Record<string, LaneConfig>;
}

export function laneRegexBoost(lanes: Record<string, LaneConfig>, lane: string): RegExp | null {
  const raw = lanes[lane]?.regex_boost;
  if (!raw) return null;
  try {
    return new RegExp(raw, "i");
  } catch {
    return null;
  }
}

export function scoreLaneBoost(
  row: { vibe_tags?: unknown; similar_artists?: unknown; playlist_name?: string | null },
  laneRe: RegExp | null,
  references: string[],
): number {
  if (!laneRe && references.length === 0) return 0;
  const tags = [
    ...normalizeTags(row.vibe_tags),
    ...normalizeTags(row.similar_artists),
    (row.playlist_name ?? "").toLowerCase(),
  ].join(" ");
  let s = 0;
  if (laneRe && laneRe.test(tags)) s += 30;
  for (const ref of references) {
    const t = ref.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
    if (t.length > 2 && tags.includes(t)) s += 15;
    for (const part of t.split(/\s+/).filter((w) => w.length > 3)) {
      if (tags.includes(part)) s += 6;
    }
  }
  return s;
}

export const MIN_LANE_BOOST_FOR_TAG = 8;

// ---------------------------------------------------------------------------
// Sweep lanes — genre-derived lanes the mass sweep stamps (see
// playlist-sweep.ts `laneForSweep`). They intentionally live OUTSIDE
// artist_config.lanes: the sweep runs with no lane param and no reference set, so
// the config-driven matching below (regex_boost + references) can't recognize
// them. Without this table, reconcile_lane_targets would see a sweep-laned row,
// find no config match, and deactivate it as "lane_mismatch" — nuking the entire
// rap/house buffer. These helpers give reconcile/rowMatchesLane a config-free way
// to validate a sweep lane against the row's own genre signal instead.
// ---------------------------------------------------------------------------
// Sweep-lane genre families — populated at runtime from discovery_profiles.
// Empty until setSweepLaneRoutingFromProfiles() runs. No catalog literals here.
export let SWEEP_LANE_GENRE: Record<string, "rap" | "house"> = {};

export function setSweepLaneRoutingFromProfiles(
  laneGenre: Record<string, "rap" | "house">,
  laneBlockPatterns?: Record<string, string>,
): void {
  SWEEP_LANE_GENRE = { ...laneGenre };
  LANE_GENRE_BLOCK = {};
  for (const [lane, pattern] of Object.entries(laneBlockPatterns ?? {})) {
    try {
      LANE_GENRE_BLOCK[lane] = new RegExp(pattern, "i");
    } catch {
      // Invalid expressions are rejected at save time; skip bad runtime values.
    }
  }
}

export function isSweepLane(lane: string): boolean {
  return Object.prototype.hasOwnProperty.call(SWEEP_LANE_GENRE, lane);
}

// Compact genre detectors for reconcile — read the row's own text, not config.
// Patterns come from discovery profile matching_expression when set; these
// defaults are generic family detectors (not catalog- or song-specific).
const FAMILY_RAP_RE =
  /\b(rap|hip ?hop|hiphop|trap|drill|boom ?bap|phonk|plugg|grime|g-?funk|gangsta|gangster|conscious|cypher|freestyle)\b/i;
const FAMILY_HOUSE_RE =
  /\b(house|techno|edm|electronic|disco|garage|amapiano|nu ?disco|balearic)\b/i;

/** Rap/house genre of a text blob, or null when neither (or both) clearly present —
 * "no contradiction" rather than a forced guess. Used only to validate an already
 * assigned sweep lane, never to assign one. */
export function sweepLaneTextGenre(text: string): "rap" | "house" | null {
  const rap = FAMILY_RAP_RE.test(text);
  const house = FAMILY_HOUSE_RE.test(text);
  if (rap && !house) return "rap";
  if (house && !rap) return "house";
  return null;
}

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).toLowerCase());
  return [];
}

/** True when a row genuinely fits the lane (used for tagging + catalog reconcile). */
export function rowMatchesLane(
  row: {
    playlist_name?: string | null;
    curator_name?: string | null;
    vibe_tags?: unknown;
    similar_artists?: unknown;
  },
  lane: string,
  laneRe: RegExp | null,
  references: string[],
): boolean {
  if (!lane) return false;
  // Sweep lanes are validated by genre, not config refs/regex (which they lack).
  // Match unless the row's own text clearly names the OPPOSITE genre.
  if (isSweepLane(lane)) {
    const want = SWEEP_LANE_GENRE[lane];
    const text = `${row.playlist_name ?? ""} ${row.curator_name ?? ""} ${normalizeTags(row.vibe_tags).join(" ")}`;
    const g = sweepLaneTextGenre(text);
    return g === null || g === want;
  }
  const laneScore = scoreLaneBoost(row, laneRe, references);
  const nameHay = `${row.playlist_name ?? ""} ${row.curator_name ?? ""}`;
  const refLower = references.map((s) => s.toLowerCase());
  const vibeTags = normalizeTags(row.vibe_tags);
  return (
    laneScore >= MIN_LANE_BOOST_FOR_TAG ||
    (laneRe?.test(nameHay) ?? false) ||
    vibeTags.some((t) => refLower.includes(t) || refLower.some((ref) => t.includes(ref) || ref.includes(t)))
  );
}

let LANE_GENRE_BLOCK: Record<string, RegExp> = {};

/** Playlist/curator name signals wrong genre for the stamped lane. */
export function isLaneGenreMismatch(
  lane: string,
  playlistName?: string | null,
  curatorName?: string | null,
): boolean {
  const hay = `${playlistName ?? ""} ${curatorName ?? ""}`;
  // Sweep lanes: a mismatch is a name/curator that clearly names the OTHER genre
  // (e.g. a "house" title stamped rap_general). Ambiguous/no-signal is NOT a
  // mismatch — the lane was assigned from richer evidence (tracks/description) at
  // ingest, so don't second-guess it from the name alone.
  if (isSweepLane(lane)) {
    const g = sweepLaneTextGenre(hay);
    return g !== null && g !== SWEEP_LANE_GENRE[lane];
  }
  const re = LANE_GENRE_BLOCK[lane];
  if (!re) return false;
  return re.test(hay);
}

export function buildWhyItFits(
  row: { playlist_name?: string | null; curator_name?: string | null; vibe_tags?: unknown; similar_artists?: unknown },
  lane: string,
  references: string[],
  laneRe: RegExp | null,
): string | null {
  const tags = [...normalizeTags(row.vibe_tags), ...normalizeTags(row.similar_artists)];
  const matchedTags = tags.filter((t) => laneRe?.test(t) ?? false).slice(0, 4);
  const matchedRefs = references.filter((r) => {
    const t = r.toLowerCase();
    return tags.some((tag) => tag.includes(t) || t.includes(tag)) ||
      (row.playlist_name ?? "").toLowerCase().includes(t.slice(0, 12));
  }).slice(0, 3);
  const parts: string[] = [];
  if (matchedTags.length) parts.push(`Tags: ${matchedTags.join(", ")}`);
  if (matchedRefs.length) parts.push(`Refs: ${matchedRefs.join("; ")}`);
  const nameHay = `${row.playlist_name ?? ""} ${row.curator_name ?? ""}`;
  if (!parts.length && laneRe?.test(nameHay)) {
    parts.push(`Title/curator matches ${lane.replace(/_/g, " ")} lane signals.`);
  }
  return parts.length ? parts.join(" · ") : null;
}
