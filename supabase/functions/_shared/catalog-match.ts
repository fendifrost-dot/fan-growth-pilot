import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { loadLanesConfig } from "./playlist-lanes.ts";

export type CatalogTrack = {
  name: string;
  lane?: string;
  stream_url?: string;
};

const DEFAULT_TRACKS: CatalogTrack[] = [
  { name: "Designed For Me (Control)", lane: "deep_house_groove" },
];

async function loadTracksFromTable(sb: SupabaseClient): Promise<CatalogTrack[]> {
  const { data: tracks } = await sb
    .from("tracks")
    .select("name, spotify_url, track_categories(categories(slug))")
    .eq("status", "active")
    .order("updated_at", { ascending: false });

  if (!tracks?.length) return [];

  return tracks.map((t) => {
    const cats = (t.track_categories ?? []) as { categories: { slug: string } | null }[];
    const lane = cats.find((c) => c.categories?.slug)?.categories?.slug;
    return {
      name: t.name as string,
      stream_url: (t.spotify_url as string | null)?.trim() || undefined,
      lane,
    };
  });
}

async function loadTracksFromJson(sb: SupabaseClient): Promise<CatalogTrack[]> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "spotify_track_urls").maybeSingle();
  const lanes = await loadLanesConfig(sb);
  if (!data?.value || typeof data.value !== "object" || Array.isArray(data.value)) {
    return DEFAULT_TRACKS;
  }
  const urls = data.value as Record<string, string>;
  return Object.entries(urls).map(([name, url]) => ({
    name,
    stream_url: url?.trim() || undefined,
    lane: Object.entries(lanes).find(([, cfg]) =>
      (cfg.pitch_angle ?? "").toLowerCase().includes(name.toLowerCase().slice(0, 12)),
    )?.[0],
  }));
}

export async function loadCatalogTracks(sb: SupabaseClient): Promise<CatalogTrack[]> {
  const fromTable = await loadTracksFromTable(sb);
  if (fromTable.length) return fromTable;
  return loadTracksFromJson(sb);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2);
}

/** Pick best catalog track to pitch based on playlist lane, vibe tags, and what they already spun. */
export function pickCatalogTrackForPlacement(
  row: Record<string, unknown>,
  catalog: CatalogTrack[],
  fallbackTrack: string,
): { track: string; reason: string } {
  const list = catalog.length ? catalog : DEFAULT_TRACKS;
  const rc = row.research_context as Record<string, unknown> | null;
  const featuring = Array.isArray(rc?.featuring_tracks) ? rc!.featuring_tracks.map(String) : [];
  const lane = String(row.lane ?? rc?.discovery_lane ?? "").trim();
  const vibeTags = [
    ...tokenize(String(row.playlist_name ?? "")),
    ...tokenize((row.why_it_fits as string) ?? ""),
    ...(Array.isArray(row.vibe_tags) ? row.vibe_tags.flatMap((t) => tokenize(String(t))) : []),
  ];

  let best = list.find((t) => t.name === fallbackTrack) ?? list[0];
  let bestScore = -1;
  let reason = "Default catalog track";

  for (const track of list) {
    if (featuring.some((f) => f.toLowerCase() === track.name.toLowerCase())) continue;
    let score = 0;
    const trackTokens = tokenize(track.name);
    if (lane && track.lane === lane) score += 40;
    for (const vt of vibeTags) {
      if (trackTokens.some((tt) => tt.includes(vt) || vt.includes(tt))) score += 8;
    }
    if (track.name === fallbackTrack) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = track;
      if (lane && track.lane === lane) reason = `Lane match (${lane})`;
      else if (bestScore > 10) reason = "Vibe/tag overlap with playlist";
      else reason = "Best available catalog match";
    }
  }

  return { track: best.name, reason };
}
