/**
 * playlist-research — FanFuel Hub
 * DB-first playlist opportunities + Spotify web discovery via Firecrawl.
 *
 * Env: FANFUEL_HUB_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FIRECRAWL_API_KEY
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  isArtistAsCurator,
  isDisclaimBrand,
  isSpotifyOwnedCurator,
} from "../_shared/curator-filters.ts";
import {
  buildWhyItFits,
  laneRegexBoost,
  loadLanesConfig,
  rowMatchesLane,
  scoreLaneBoost,
} from "../_shared/playlist-lanes.ts";
import {
  scrapeSpotifyPlaylistDetail,
  scrapeSpotifySearchPlaylists,
  scrapeSpotifyUserProfile,
  sleep,
} from "../_shared/spotify-scrape.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const MAX_RESULTS = 20;
const DISCOVER_DEADLINE_MS = 55_000;
const SEARCH_REF_CAP_FULL = 5;
const STUBS_PER_REF_FULL = 10;
const DETAIL_CAP_FULL = 20;
const SEARCH_REF_CAP_QUICK = 2;
const STUBS_PER_REF_QUICK = 6;
const DETAIL_CAP_QUICK = 8;
type DiscoverySkips = {
  disclaim_brand: number;
  casual_user: number;
  micro_playlist: number;
  artist_as_curator: number;
  spotify_owned: number;
};

function sanitizeWhyItFits(raw: string | null): string | null {
  if (!raw || raw.length <= 15 || /^lane\s*:/i.test(raw)) return null;
  return raw;
}

function getHubKey(req: Request): string {
  return (
    req.headers.get("x-api-key") ||
    req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  );
}

type PlaylistRow = {
  playlist_id: string;
  platform: string;
  playlist_name: string | null;
  curator_name: string | null;
  follower_count: number | null;
  track_count: number | null;
  overlap_score: number | null;
  fraud_score: number | null;
  fraud_verdict: string | null;
  pitch_status: string | null;
  research_context: Record<string, unknown> | null;
  tier: number | null;
  whitelist_status: boolean | null;
  vibe_tags: string[] | unknown;
  similar_artists: string[] | unknown;
  submission_method: string | null;
  submission_url: string | null;
  curator_email: string | null;
  is_active: boolean | null;
  match_score?: number;
  source?: "catalog" | "live";
};

type DiscoveredPlaylist = {
  id: string;
  playlist_id: string;
  name: string;
  description?: string;
  followers: number | null;
  owner: string | null;
  owner_id?: string;
  _track_artists?: string[];
};

function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).toLowerCase());
  return [];
}

function tokenizeVibe(vibe: string): Set<string> {
  return new Set(
    vibe
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function isWebDiscovered(rc: Record<string, unknown> | null): boolean {
  const src = rc?.source;
  return src === "spotify_web" || src === "live_api";
}

/** Penalize micro-playlists and placeholder names so pitchable curators rank higher. */
function curatorQualityPenalty(row: PlaylistRow): number {
  let p = 0;
  const saves = row.follower_count ?? 0;
  const name = row.playlist_name ?? "";
  if (saves > 0 && saves < 50) p += 25;
  if (/^Playlist [a-zA-Z0-9]{4,8}/i.test(name)) p += 15;
  if (saves === 0 && isWebDiscovered(row.research_context as Record<string, unknown> | null)) p += 8;
  return p;
}

function scoreRow(
  row: PlaylistRow,
  vibeTokens: Set<string>,
  trackTokens: Set<string>,
  extraLaneScore = 0,
): number {
  const tags = new Set([...normalizeTags(row.vibe_tags), ...normalizeTags(row.similar_artists)]);
  let s = 0;
  for (const t of vibeTokens) {
    if (tags.has(t)) s += 3;
    for (const tag of tags) {
      if (tag.includes(t) || t.includes(tag)) s += 1;
    }
  }
  for (const t of trackTokens) {
    if ((row.playlist_name ?? "").toLowerCase().includes(t)) s += 2;
  }
  s += Math.min(20, Math.floor((row.fraud_score ?? 0) / 5));
  if (row.whitelist_status) s += 15;
  if (row.tier === 1) s += 10;
  else if (row.tier === 2) s += 5;
  return s + extraLaneScore - curatorQualityPenalty(row);
}

function inferVibeTags(trackArtists: string[], references: string[]): string[] {
  const tags = new Set<string>();
  const lowerRefs = references.map((r) => r.toLowerCase().split(/[—–-]/)[0].trim());
  for (const artist of trackArtists) {
    const lower = artist.toLowerCase();
    for (const ref of lowerRefs) {
      const refNorm = ref.replace(/[^a-z0-9\s]/g, " ").trim();
      if (!refNorm) continue;
      if (lower.includes(refNorm) || refNorm.includes(lower)) {
        tags.add(refNorm.replace(/\s+/g, "_"));
      }
      for (const part of refNorm.split(/\s+/).filter((w) => w.length > 3)) {
        if (lower.includes(part)) tags.add(part);
      }
    }
  }
  return [...tags];
}

/** Core catalog query + ranking (matches your approved logic). */
export async function findPlaylistOpportunities(
  supabase: SupabaseClient,
  trackName: string,
  userVibe: string,
): Promise<PlaylistRow[]> {
  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);

  const { data: cooling, error: coolErr } = await supabase
    .from("pitch_log")
    .select("playlist_id")
    .eq("track_name", trackName)
    .gt("cooldown_until", new Date().toISOString());

  if (coolErr) console.error("pitch_log cooldown query:", coolErr.message);

  const excluded = new Set((cooling ?? []).map((r: { playlist_id: string }) => r.playlist_id));

  const { data: rows, error } = await supabase
    .from("playlist_targets")
    .select(
      "playlist_id, platform, playlist_name, curator_name, follower_count, track_count, overlap_score, fraud_score, fraud_verdict, pitch_status, research_context, tier, whitelist_status, vibe_tags, similar_artists, submission_method, submission_url, curator_email, is_active",
    )
    .eq("is_active", true)
    .in("tier", [1, 2])
    .eq("fraud_verdict", "safe");

  if (error) throw new Error(`playlist_targets: ${error.message}`);
  const filtered = (rows ?? []).filter((r: { playlist_id: string }) => !excluded.has(r.playlist_id));

  const scored: PlaylistRow[] = filtered.map((r: PlaylistRow) => ({
    ...r,
    match_score: scoreRow(r, vibeTokens, trackTokens),
    source: "catalog",
  }));

  scored.sort((a, b) => {
    const ms = (b.match_score ?? 0) - (a.match_score ?? 0);
    if (ms !== 0) return ms;
    return (b.follower_count ?? 0) - (a.follower_count ?? 0);
  });

  return scored.slice(0, MAX_RESULTS);
}

async function discoverViaSpotifyWeb(
  references: string[],
  lane: string,
  quick = false,
): Promise<DiscoveredPlaylist[]> {
  const refCap = quick ? SEARCH_REF_CAP_QUICK : SEARCH_REF_CAP_FULL;
  const stubsPerRef = quick ? STUBS_PER_REF_QUICK : STUBS_PER_REF_FULL;
  const detailCap = quick ? DETAIL_CAP_QUICK : DETAIL_CAP_FULL;

  const deadline = Date.now() + DISCOVER_DEADLINE_MS;
  const laneLabel = lane ? lane.replace(/_/g, " ") : "";
  const refQueries = references
    .slice(0, Math.max(1, refCap - (laneLabel ? 2 : 0)))
    .map((r) => r.split(/[—–-]/)[0].trim())
    .filter(Boolean);
  const laneQueries = laneLabel
    ? [`${laneLabel} playlist`, `${laneLabel} curator`]
    : [];
  const queries = [...new Set([...laneQueries, ...refQueries])].slice(0, refCap);

  if (!queries.length) {
    console.warn("[playlist-research] no references or lane for web discovery");
    return [];
  }

  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    console.error("[playlist-research] FIRECRAWL_API_KEY not set — skipping web discovery");
    return [];
  }

  const seen = new Set<string>();
  const out: DiscoveredPlaylist[] = [];
  const log: { query: string; count: number; ok: boolean }[] = [];

  for (const query of queries) {
    if (Date.now() > deadline) break;
    try {
      const stubs = await scrapeSpotifySearchPlaylists(query);
      let added = 0;
      for (const s of stubs.slice(0, stubsPerRef)) {
        if (!s.playlist_id) continue;
        const pid = `spotify:${s.playlist_id}`;
        if (seen.has(pid)) continue;
        seen.add(pid);
        added++;
        out.push({
          id: s.playlist_id,
          playlist_id: pid,
          name: s.name,
          followers: null,
          owner: s.owner_name ?? null,
          owner_id: s.owner_id,
        });
      }
      log.push({ query, count: added, ok: true });
      await sleep(1200);
    } catch (e) {
      log.push({ query, count: 0, ok: false });
      console.error(`[discover] search "${query}" failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  const toDetail = out.slice(0, detailCap);
  for (const pl of toDetail) {
    if (Date.now() > deadline) break;
    try {
      const detail = await scrapeSpotifyPlaylistDetail(pl.id);
      if (detail) {
        if (detail.name) pl.name = detail.name;
        pl.description = detail.description;
        pl.followers = detail.follower_count ?? pl.followers;
        pl.owner = detail.owner_name ?? pl.owner;
        pl.owner_id = detail.owner_id ?? pl.owner_id;
        pl._track_artists = detail.track_artists ?? [];
      }
      await sleep(1000);
    } catch (e) {
      console.error(`[discover] detail ${pl.id} failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  out.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
  console.log("[playlist-research] web discover log:", JSON.stringify(log), "total:", out.length);
  return out;
}

async function filterDiscoveryCandidates(
  items: DiscoveredPlaylist[],
  references: string[],
  quick: boolean,
): Promise<{ items: DiscoveredPlaylist[]; skips: DiscoverySkips }> {
  const skips: DiscoverySkips = {
    disclaim_brand: 0,
    casual_user: 0,
    micro_playlist: 0,
    artist_as_curator: 0,
    spotify_owned: 0,
  };
  const kept: DiscoveredPlaylist[] = [];

  for (const pl of items) {
    if (isSpotifyOwnedCurator(pl.owner, pl.name, pl.playlist_id)) {
      console.log("[discover] spotify-owned skip:", pl.playlist_id, pl.name, pl.owner);
      skips.spotify_owned++;
      continue;
    }
    if (isArtistAsCurator(pl.owner, references)) {
      console.log("[discover] artist-as-curator skip:", pl.playlist_id, pl.owner);
      skips.artist_as_curator++;
      continue;
    }
    const haystack = [pl.name, pl.owner, pl.description ?? ""].join(" ");
    if (isDisclaimBrand(haystack)) {
      console.log("[discover] disclaim-brand skip:", pl.playlist_id, pl.name);
      skips.disclaim_brand++;
      continue;
    }
    if (pl.followers != null && pl.followers < 50) {
      console.log("[discover] micro-playlist skip:", pl.playlist_id, pl.name, "saves:", pl.followers);
      skips.micro_playlist++;
      continue;
    }
    if (!quick && pl.owner_id) {
      try {
        const profile = await scrapeSpotifyUserProfile(pl.owner_id);
        const fc = profile?.follower_count;
        const fg = profile?.following_count;
        if (fc != null && fg != null && fc < 1000 && fc < fg) {
          console.log("[discover] casual-user skip:", pl.playlist_id, pl.owner, fc, "<", fg);
          skips.casual_user++;
          await sleep(800);
          continue;
        }
      } catch (e) {
        console.error("[discover] profile scrape failed:", pl.owner_id, e instanceof Error ? e.message : e);
      }
      await sleep(800);
    }
    kept.push(pl);
  }

  return { items: kept, skips };
}

async function upsertLiveResults(
  supabase: SupabaseClient,
  items: DiscoveredPlaylist[],
  lane: string,
  references: string[],
  laneRe: RegExp | null,
): Promise<void> {
  for (const pl of items) {
    const vibe_tags = inferVibeTags(pl._track_artists ?? [], references);
    const stub: PlaylistRow = {
      playlist_id: pl.playlist_id,
      platform: "spotify",
      playlist_name: pl.name,
      curator_name: pl.owner,
      follower_count: pl.followers,
      track_count: null,
      overlap_score: null,
      fraud_score: null,
      fraud_verdict: null,
      pitch_status: null,
      research_context: null,
      tier: null,
      whitelist_status: null,
      vibe_tags,
      similar_artists: references.slice(0, 8),
      submission_method: null,
      submission_url: null,
      curator_email: null,
      is_active: null,
    };
    const tagLane = rowMatchesLane(stub, lane, laneRe, references);
    const row = {
      playlist_id: pl.playlist_id,
      platform: "spotify",
      playlist_name: pl.name,
      curator_name: pl.owner,
      follower_count: pl.followers ?? 0,
      track_count: 0,
      overlap_score: 0,
      fraud_score: 50,
      fraud_verdict: "safe",
      pitch_status: "not_pitched",
      research_context: {
        source: "spotify_web",
        fetched_at: new Date().toISOString(),
        spotify_owner_id: pl.owner_id ?? null,
        discovery_lane: lane || null,
        references: references.slice(0, 8),
      },
      tier: 2,
      whitelist_status: false,
      vibe_tags,
      similar_artists: references.slice(0, 8),
      submission_method: "email",
      submission_url: `https://open.spotify.com/playlist/${pl.id}`,
      is_active: true,
      ...(tagLane && lane ? { lane } : {}),
    };
    const { error } = await supabase.from("playlist_targets").upsert(row, {
      onConflict: "playlist_id",
    });
    if (error) console.error("upsert live", pl.playlist_id, error.message);
  }
}

export async function mergeCatalogAndLive(
  supabase: SupabaseClient,
  trackName: string,
  userVibe: string,
  opts?: { lane?: string; references?: string[]; quick?: boolean },
): Promise<{ results: PlaylistRow[]; live_count: number; discovery_skips: DiscoverySkips }> {
  await findPlaylistOpportunities(supabase, trackName, userVibe);
  const lane = (opts?.lane ?? "").trim();
  const references = opts?.references ?? [];
  const lanesConfig = await loadLanesConfig(supabase);
  const laneRe = lane ? laneRegexBoost(lanesConfig, lane) : null;
  const pitchAngle = lane ? (lanesConfig[lane]?.pitch_angle ?? "") : "";

  const start = Date.now();
  const quick = Boolean(opts?.quick);
  const discovered = await discoverViaSpotifyWeb(references, lane, quick);
  const discovery_skips: DiscoverySkips = {
    disclaim_brand: 0,
    casual_user: 0,
    micro_playlist: 0,
    artist_as_curator: 0,
    spotify_owned: 0,
  };
  let live: DiscoveredPlaylist[] = [];
  if (discovered.length) {
    const filtered = await filterDiscoveryCandidates(discovered, references, quick);
    discovery_skips.disclaim_brand = filtered.skips.disclaim_brand;
    discovery_skips.casual_user = filtered.skips.casual_user;
    discovery_skips.micro_playlist = filtered.skips.micro_playlist;
    discovery_skips.artist_as_curator = filtered.skips.artist_as_curator;
    discovery_skips.spotify_owned = filtered.skips.spotify_owned;
    live = filtered.items;
    if (live.length) {
      await upsertLiveResults(supabase, live, lane, references, laneRe);
    }
  }
  console.log(
    `[playlist-research] web discovery: ${discovered.length} found, ${live.length} ingested, skips:`,
    JSON.stringify(discovery_skips),
    `${Date.now() - start}ms`,
  );

  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);

  const { data: mergedRows } = await supabase
    .from("playlist_targets")
    .select(
      "playlist_id, platform, playlist_name, curator_name, follower_count, track_count, overlap_score, fraud_score, fraud_verdict, pitch_status, research_context, tier, whitelist_status, vibe_tags, similar_artists, submission_method, submission_url, curator_email, is_active",
    )
    .eq("is_active", true)
    .in("tier", [1, 2])
    .eq("fraud_verdict", "safe");

  const { data: cooling } = await supabase
    .from("pitch_log")
    .select("playlist_id")
    .eq("track_name", trackName)
    .gt("cooldown_until", new Date().toISOString());

  const excluded = new Set((cooling ?? []).map((r: { playlist_id: string }) => r.playlist_id));
  const merged = (mergedRows ?? [])
    .filter((r: { playlist_id: string }) => !excluded.has(r.playlist_id))
    .map((r: PlaylistRow & { research_context?: Record<string, unknown> | null }) => {
      const rc = r.research_context as Record<string, unknown> | null;
      const source = isWebDiscovered(rc) ? "live" : "catalog";
      const laneScore = scoreLaneBoost(r, laneRe, references);
      const matchesLane = rowMatchesLane(r, lane, laneRe, references);
      const why_it_fits = matchesLane
        ? sanitizeWhyItFits(buildWhyItFits(r, lane, references, laneRe))
        : null;
      return {
        ...r,
        match_score: scoreRow(r, vibeTokens, trackTokens, laneScore),
        source: source as "catalog" | "live",
        lane: matchesLane ? lane : ((r as { lane?: string }).lane ?? null),
        why_it_fits,
        recommended_pitch_angle: matchesLane
          ? (pitchAngle || (r as { recommended_pitch_angle?: string }).recommended_pitch_angle || null)
          : ((r as { recommended_pitch_angle?: string }).recommended_pitch_angle ?? null),
      };
    });

  merged.sort((a: { match_score?: number; follower_count?: number | null }, b: { match_score?: number; follower_count?: number | null }) => {
    const ms = (b.match_score ?? 0) - (a.match_score ?? 0);
    if (ms !== 0) return ms;
    return (b.follower_count ?? 0) - (a.follower_count ?? 0);
  });

  const results = merged.slice(0, MAX_RESULTS);
  for (const r of results) {
    const patch: Record<string, unknown> = {};
    const matchesLane = rowMatchesLane(r, lane, laneRe, references);
    if (matchesLane) {
      patch.lane = lane;
      const why = (r as { why_it_fits?: string | null }).why_it_fits;
      if (why) patch.why_it_fits = why;
      const angle = (r as { recommended_pitch_angle?: string | null }).recommended_pitch_angle;
      if (angle) patch.recommended_pitch_angle = angle;
    }
    if (Object.keys(patch).length === 0) continue;
    const { error } = await supabase.from("playlist_targets").update(patch).eq("playlist_id", r.playlist_id);
    if (error) console.error("lane patch", r.playlist_id, error.message);
  }

  return {
    results,
    live_count: live.length,
    discovery_skips,
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = getServiceClient();
    const body = await req.json().catch(() => ({}));
    const track_name = String(body.track_name ?? body.trackName ?? "").trim();
    const user_vibe = String(body.user_vibe ?? body.userVibe ?? body.vibe ?? "").trim();
    const references = Array.isArray(body.references) ? body.references.map(String) : [];
    const lane = String(body.lane ?? "").trim();

    if (!track_name) {
      return json({ error: "track_name required" }, 400);
    }

    const quick = Boolean(body.quick);
    const { results, live_count, discovery_skips } = await mergeCatalogAndLive(supabase, track_name, user_vibe, {
      lane,
      references,
      quick,
    });

    const playlists = results.map((r) => ({
      ...r,
      followers: r.follower_count,
      followers_label:
        r.follower_count != null
          ? r.follower_count.toLocaleString()
          : r.submission_method === "algorithmic" || r.submission_method === "distributor_pitch"
            ? "editorial"
            : "N/A",
    }));

    return json({
      ok: true,
      track_name,
      user_vibe: user_vibe,
      lane: lane || null,
      references,
      count: results.length,
      live_api_ingested: live_count,
      discovery_skips,
      quick,
      playlists,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return json({ error: true, message: msg }, 500);
  }
});
