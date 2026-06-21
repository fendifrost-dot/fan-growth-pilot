import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { firecrawlSearch } from "./firecrawl.ts";
import {
  isSpotifyOwnedCurator,
  isArtistAsCurator,
  isDisclaimBrand,
} from "./curator-filters.ts";
import { scrapeSpotifyPlaylistDetail, scrapeSpotifySearchPlaylists, sleep } from "./spotify-scrape.ts";
import { loadLanesConfig, rowMatchesLane, laneRegexBoost } from "./playlist-lanes.ts";

const PLAYLIST_ID_RE = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/g;
const DETAIL_CAP = 50;
const SEARCH_LIMIT = 10;

export type PlacementDiscoveryResult = {
  found: number;
  verified: number;
  ingested: number;
  skipped: Record<string, number>;
};

function extractPlaylistIds(blob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(PLAYLIST_ID_RE.source, "g");
  while ((m = re.exec(blob)) !== null) {
    const id = m[1];
    if (id.startsWith("37i9dQZF")) continue;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function artistAppearsInDetail(
  artistName: string,
  detail: { name?: string; description?: string; track_artists?: string[] },
  markdownHint: string,
): { match: boolean; tracks: string[] } {
  const needle = artistName.toLowerCase();
  const tracks: string[] = [];
  const artists = (detail.track_artists ?? []).map((a) => a.toLowerCase());
  if (artists.some((a) => a.includes(needle))) {
    tracks.push(...(detail.track_artists ?? []).filter((a) => a.toLowerCase().includes(needle)));
  }
  const blob = [detail.name, detail.description, markdownHint].join(" ").toLowerCase();
  if (blob.includes(needle)) {
    if (!tracks.length) tracks.push("(playlist page mention)");
  }
  return { match: tracks.length > 0 || blob.includes(needle), tracks };
}

async function resolveArtistName(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "artist_display_name").maybeSingle();
  const fromCfg = typeof data?.value === "string" ? data.value.trim() : "";
  if (fromCfg) return fromCfg;
  return (Deno.env.get("ARTIST_DISPLAY_NAME") || "Fendi Frost").trim();
}

async function resolveCatalogTracks(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "spotify_track_urls").maybeSingle();
  if (data?.value && typeof data.value === "object" && !Array.isArray(data.value)) {
    return Object.keys(data.value as Record<string, string>).filter(Boolean);
  }
  return ["Designed For Me (Control)"];
}

export async function discoverSpotifyPlacements(
  sb: SupabaseClient,
  opts: {
    artist_name?: string;
    track_names?: string[];
    lane?: string;
    references?: string[];
    quick?: boolean;
  },
): Promise<PlacementDiscoveryResult> {
  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    throw new Error("FIRECRAWL_API_KEY not configured");
  }

  const artistName = (opts.artist_name || await resolveArtistName(sb)).trim();
  const tracks = opts.track_names?.length ? opts.track_names : await resolveCatalogTracks(sb);
  const lane = (opts.lane ?? "").trim();
  const references = opts.references ?? [];
  const lanesConfig = await loadLanesConfig(sb);
  const laneRe = lane ? laneRegexBoost(lanesConfig, lane) : null;

  const laneLabel = lane ? lane.replace(/_/g, " ") : "";
  const queries = [
    `"${artistName}" site:open.spotify.com/playlist`,
    `${artistName} playlist spotify`,
    `${artistName} spotify playlist submission`,
    ...(laneLabel ? [`${artistName} ${laneLabel} playlist`, `${laneLabel} playlist curator`] : []),
    ...references.slice(0, 3).map((r) => `${artistName} ${r.split(/[—–-]/)[0].trim()} playlist`),
    ...tracks.slice(0, 8).map((t) => `"${t}" "${artistName}" spotify playlist`),
    ...tracks.slice(0, 4).map((t) => `"${t}" spotify playlist`),
  ];

  const seen = new Set<string>();
  const skipped: Record<string, number> = {
    editorial: 0,
    spotify_owned: 0,
    artist_curator: 0,
    disclaim: 0,
    no_artist_match: 0,
    detail_fail: 0,
  };

  for (const q of queries) {
    try {
      const hits = await firecrawlSearch(q, SEARCH_LIMIT);
      const blob = hits.map((h) => `${h.url}\n${h.title ?? ""}\n${h.description ?? ""}`).join("\n");
      for (const id of extractPlaylistIds(blob)) {
        seen.add(id);
      }
      const searchStubs = await scrapeSpotifySearchPlaylists(`${artistName} playlist`);
      for (const s of searchStubs.slice(0, 6)) {
        if (s.playlist_id) seen.add(s.playlist_id);
      }
      await sleep(1200);
    } catch (e) {
      console.error("[placements] search failed:", q, e instanceof Error ? e.message : e);
    }
  }

  const found = seen.size;
  // Dedupe against the 90-day pitch log so re-runs spend the detail-scrape
  // budget on genuinely new playlists rather than recently-pitched ones.
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const recentlyPitched = new Set<string>();
  try {
    const { data: recent } = await sb
      .from("pitch_log")
      .select("playlist_id, pitched_at, created_at")
      .or(`pitched_at.gte.${since90},created_at.gte.${since90}`)
      .limit(5000);
    for (const r of recent ?? []) {
      const pid = (r as { playlist_id?: string }).playlist_id;
      if (pid) recentlyPitched.add(pid.replace(/^spotify:/, ""));
    }
  } catch (e) {
    console.error("[placements] recent pitch_log query failed:", e instanceof Error ? e.message : e);
  }
  const ids = [...seen].filter((id) => !recentlyPitched.has(id)).slice(0, DETAIL_CAP);
  let verified = 0;
  let ingested = 0;

  for (const id of ids) {
    const playlistId = `spotify:${id}`;
    if (id.startsWith("37i9dQZF")) {
      skipped.editorial++;
      continue;
    }

    const detail = await scrapeSpotifyPlaylistDetail(id);
    if (!detail) {
      skipped.detail_fail++;
      await sleep(800);
      continue;
    }

    const owner = detail.owner_name ?? null;
    const { match, tracks: matchedTracks } = artistAppearsInDetail(artistName, detail, detail.description ?? "");
    if (!match) {
      skipped.no_artist_match++;
      await sleep(800);
      continue;
    }
    verified++;

    if (isSpotifyOwnedCurator(owner, detail.name, playlistId)) {
      skipped.spotify_owned++;
      continue;
    }
    if (isArtistAsCurator(owner, references)) {
      skipped.artist_curator++;
      continue;
    }
    const hay = [detail.name, owner, detail.description].join(" ");
    if (isDisclaimBrand(hay)) {
      skipped.disclaim++;
      continue;
    }

    const stub = {
      playlist_id: playlistId,
      platform: "spotify",
      playlist_name: detail.name,
      curator_name: owner,
      follower_count: detail.follower_count ?? 0,
      vibe_tags: detail.track_artists?.slice(0, 12) ?? [],
      similar_artists: references.slice(0, 8),
      research_context: {
        source: "spotify_placement",
        artist_name: artistName,
        featuring_tracks: matchedTracks,
        discovered_at: new Date().toISOString(),
        spotify_owner_id: detail.owner_id ?? null,
        engagement_recommended: "thank_and_pitch",
      },
    };

    const tagLane = lane ? rowMatchesLane(stub as never, lane, laneRe, references) : false;

    const row = {
      playlist_id: playlistId,
      platform: "spotify",
      playlist_name: detail.name,
      curator_name: owner,
      follower_count: detail.follower_count ?? 0,
      track_count: 0,
      overlap_score: 85,
      fraud_score: 20,
      fraud_verdict: "safe",
      pitch_status: "not_pitched",
      research_context: stub.research_context,
      tier: 1,
      whitelist_status: false,
      vibe_tags: stub.vibe_tags,
      similar_artists: references.slice(0, 8),
      submission_method: "instagram_dm",
      submission_url: `https://open.spotify.com/playlist/${id}`,
      is_active: true,
      why_it_fits: `Already features ${artistName} — warm placement for catalog pitch.`,
      ...(tagLane && lane ? { lane } : {}),
    };

    const { error } = await sb.from("playlist_targets").upsert(row, { onConflict: "playlist_id" });
    if (!error) ingested++;
    else console.error("[placements] upsert", playlistId, error.message);
    await sleep(1000);
  }

  return { found, verified, ingested, skipped };
}
