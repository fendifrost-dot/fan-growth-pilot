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

const LANE_GENRE_BLOCK: Record<string, RegExp> = {
  deep_house_groove: /\b(rap|hip ?hop|hiphop|trap|drill)\b/i,
};

/** Playlist/curator name signals wrong genre for the stamped lane. */
export function isLaneGenreMismatch(
  lane: string,
  playlistName?: string | null,
  curatorName?: string | null,
): boolean {
  const re = LANE_GENRE_BLOCK[lane];
  if (!re) return false;
  return re.test(`${playlistName ?? ""} ${curatorName ?? ""}`);
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
