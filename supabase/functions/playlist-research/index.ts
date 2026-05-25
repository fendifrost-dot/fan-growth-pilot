/**
 * playlist-research — FanFuel Hub
 * DB-first playlist opportunities + capped live Spotify supplement.
 * Upserts catalog rows WITHOUT track_name (global catalog model).
 *
 * Env: FANFUEL_HUB_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET (optional live search)
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  buildWhyItFits,
  laneRegexBoost,
  loadLanesConfig,
  scoreLaneBoost,
} from "../_shared/playlist-lanes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const MAX_RESULTS = 20;
const LIVE_SEARCH_TERMS_MAX = 8;
const LIVE_SEARCH_BUDGET_MS = 3000;

/** Dropped from Spotify search token lists so prose like "No think more like…" does not eat the term budget. */
const LIVE_SEARCH_STOPWORDS = new Set([
  "the", "and", "for", "you", "are", "but", "not", "all", "can", "her", "was", "one", "our", "out", "get", "use",
  "man", "new", "now", "way", "may", "say", "she", "too", "any", "does", "have", "like", "just", "more", "look",
  "than", "them", "well", "also", "back", "after", "think", "with", "from", "they", "know", "want", "been", "good",
  "much", "some", "time", "very", "when", "come", "here", "how", "why", "into", "your", "this", "that", "then",
  "what", "make", "reply", "send", "type", "cancel", "abort", "yes", "own", "message", "same", "these", "those",
  "really", "dont", "don", "wont", "cant", "should", "could", "would", "please", "need", "want", "tell", "give",
]);

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

function detectGenreSignals(vibe: string): Record<string, boolean> {
  const v = vibe.toLowerCase();
  return {
    drill: /drill|fbg|g herbo|chicago drill|bando|opps/.test(v),
    spiritual: /spiritual|holistic|healing|meditation|conscious|mindful|native|flute/.test(v),
    westCoast: /west coast|cali|larry june|dom kennedy|la rap/.test(v),
    trap: /trap|808|banger|turn up/.test(v),
    underground: /underground|griselda|boldy|freddie gibbs|stove god/.test(v),
    houseGroove:
      /house|kaytranada|channel\s*tres|uk\s*garage|garage\b|deep\s*house|club\s*rap|dance\s*rap|nu\s*disco|groove|funk|slutty\s*bass|amine|duckwrth|sg\s*lewis|edm|four\s*on\s*the\s*floor|indie\s*dance|electronic/.test(
        v,
      ),
    altRnb: /alt(?:ernative)?\s*rnb|r&b|late\s*night\s*drive|vibe\s*rnb|groove\s*rnb|alternative\s*rnb/.test(v),
  };
}

function scoreRow(
  row: PlaylistRow,
  vibeTokens: Set<string>,
  trackTokens: Set<string>,
  genreSignals?: Record<string, boolean>,
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
  if (genreSignals) {
    const tagArr = normalizeTags(row.vibe_tags);
    const artistArr = normalizeTags(row.similar_artists);
    const allTags = [...tagArr, ...artistArr].join(" ");
    if (genreSignals.drill && /drill|herbo|fbg|chicago/.test(allTags)) s += 15;
    if (genreSignals.spiritual && /spiritual|conscious|meditation|holistic/.test(allTags)) s += 15;
    if (genreSignals.westCoast && /west_coast|larry_june|dom_kennedy|cali/.test(allTags)) s += 15;
    if (genreSignals.trap && /trap|808/.test(allTags)) s += 10;
    if (genreSignals.underground && /griselda|underground|boldy|freddie/.test(allTags)) s += 10;
    if (genreSignals.houseGroove && /house|dance|club|groove|disco|garage|funk|electronic|ukg|rap/.test(allTags)) {
      s += 15;
    }
    if (genreSignals.altRnb && /rnb|r&b|soul|groove|alt/.test(allTags)) s += 12;
  }
  return s + extraLaneScore;
}

/** Core catalog query + ranking (matches your approved logic). */
export async function findPlaylistOpportunities(
  supabase: SupabaseClient,
  trackName: string,
  userVibe: string,
): Promise<PlaylistRow[]> {
  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);
  const genreSignals = detectGenreSignals(userVibe);

  const { data: cooling, error: coolErr } = await supabase
    .from("pitch_log")
    .select("playlist_id")
    .eq("track_name", trackName)
    .gt("cooldown_until", new Date().toISOString());

  if (coolErr) console.error("pitch_log cooldown query:", coolErr.message);

  const excluded = new Set((cooling ?? []).map((r: any) => r.playlist_id));

  const { data: rows, error } = await supabase
    .from("playlist_targets")
    .select(
      "playlist_id, platform, playlist_name, curator_name, follower_count, track_count, overlap_score, fraud_score, fraud_verdict, pitch_status, research_context, tier, whitelist_status, vibe_tags, similar_artists, submission_method, submission_url, curator_email, is_active",
    )
    .eq("is_active", true)
    .in("tier", [1, 2])
    .eq("fraud_verdict", "safe");

  if (error) throw new Error(`playlist_targets: ${error.message}`);
  const filtered = (rows ?? []).filter((r: any) => !excluded.has(r.playlist_id));

  const scored: PlaylistRow[] = filtered.map((r: any) => ({
    ...r,
    match_score: scoreRow(r as PlaylistRow, vibeTokens, trackTokens, genreSignals),
    source: "catalog",
  }));

  scored.sort((a, b) => {
    const ms = (b.match_score ?? 0) - (a.match_score ?? 0);
    if (ms !== 0) return ms;
    return (b.follower_count ?? 0) - (a.follower_count ?? 0);
  });

  return scored.slice(0, MAX_RESULTS);
}

async function getSpotifyAccessToken(): Promise<string | null> {
  const id = Deno.env.get("SPOTIFY_CLIENT_ID");
  const secret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!id || !secret) return null;
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${id}:${secret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.access_token ?? null;
}

function extractQuotedPhrases(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{2,80})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const t = m[1].trim();
    if (t.length >= 2) out.push(t);
  }
  return out;
}

function buildLiveSearchTerms(trackName: string, userVibe: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim().slice(0, 80);
    if (t.length < 2) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };

  for (const phrase of extractQuotedPhrases(userVibe)) {
    push(phrase);
    if (terms.length >= LIVE_SEARCH_TERMS_MAX) return terms;
  }

  const vibeWords = [...tokenizeVibe(userVibe)].filter((w) => !LIVE_SEARCH_STOPWORDS.has(w));
  const trackWords = [...tokenizeVibe(trackName)].filter((w) => !LIVE_SEARCH_STOPWORDS.has(w));
  // When the user wrote a real vibe, search Spotify with vibe-first terms (title-only tokens like "balenciaga" are weak for playlist discovery).
  const ordered = userVibe.trim().length > 0 ? [...vibeWords, ...trackWords] : [...trackWords, ...vibeWords];
  for (const w of ordered) {
    push(w);
    if (terms.length >= LIVE_SEARCH_TERMS_MAX) break;
  }

  if (terms.length === 0 && trackName.trim()) push(trackName.slice(0, 40));
  return terms.slice(0, LIVE_SEARCH_TERMS_MAX);
}

async function liveSpotifySearch(
  token: string,
  terms: string[],
  budgetMs: number,
): Promise<SpotifyApiPlaylist[]> {
  const deadline = Date.now() + budgetMs;
  const out: SpotifyApiPlaylist[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    if (Date.now() > deadline) break;
    const left = Math.max(0, deadline - Date.now());
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), Math.min(1200, left));
    try {
      const u = new URL("https://api.spotify.com/v1/search");
      u.searchParams.set("q", term);
      u.searchParams.set("type", "playlist");
      u.searchParams.set("limit", "5");
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!res.ok) continue;
      const j = await res.json();
      const items = j.playlists?.items ?? [];
      for (const pl of items) {
        if (!pl?.id) continue;
        const pid = `spotify:${pl.id}`;
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.push({
          id: pl.id,
          playlist_id: pid,
          name: pl.name,
          followers: pl.followers?.total ?? null,
          owner: pl.owner?.display_name ?? null,
        });
      }
    } catch {
      clearTimeout(to);
    }
  }
  return out;
}

type SpotifyApiPlaylist = {
  id: string;
  playlist_id: string;
  name: string;
  followers: number | null;
  owner: string | null;
};

/** Upsert live rows — no track_name; matches existing spotify:{id} keys */
async function upsertLiveResults(
  supabase: SupabaseClient,
  items: SpotifyApiPlaylist[],
): Promise<void> {
  for (const pl of items) {
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
      research_context: { source: "live_api", fetched_at: new Date().toISOString() },
      tier: 2,
      whitelist_status: false,
      vibe_tags: [],
      similar_artists: [],
      submission_method: null,
      submission_url: `https://open.spotify.com/playlist/${pl.id}`,
      is_active: true,
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
  opts?: { lane?: string; references?: string[] },
): Promise<{ results: PlaylistRow[]; live_count: number }> {
  await findPlaylistOpportunities(supabase, trackName, userVibe);
  const lane = (opts?.lane ?? "").trim();
  const references = opts?.references ?? [];
  const lanesConfig = await loadLanesConfig(supabase);
  const laneRe = lane ? laneRegexBoost(lanesConfig, lane) : null;
  const pitchAngle = lane ? (lanesConfig[lane]?.pitch_angle ?? "") : "";
  const token = await getSpotifyAccessToken();
  let live: SpotifyApiPlaylist[] = [];

  if (token) {
    const terms = buildLiveSearchTerms(trackName, userVibe);
    const start = Date.now();
    live = await liveSpotifySearch(token, terms, LIVE_SEARCH_BUDGET_MS);
    const elapsed = Date.now() - start;
    if (live.length) {
      await upsertLiveResults(supabase, live);
    }
    console.log(`live search: ${live.length} playlists in ${elapsed}ms`);
  }

  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);
  const genreSignals = detectGenreSignals(userVibe);

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

  const excluded = new Set((cooling ?? []).map((r: any) => r.playlist_id));
  const merged = (mergedRows ?? [])
    .filter((r: any) => !excluded.has(r.playlist_id))
    .map((r: any) => {
      const rc = r.research_context as Record<string, unknown> | null;
      const source = rc?.source === "live_api" ? "live" : "catalog";
      const laneScore = scoreLaneBoost(r, laneRe, references);
      const why_it_fits = buildWhyItFits(r, lane, references, laneRe);
      return {
        ...r,
        match_score: scoreRow(r as PlaylistRow, vibeTokens, trackTokens, genreSignals, laneScore),
        source: source as "catalog" | "live",
        lane: lane || r.lane || null,
        why_it_fits,
        recommended_pitch_angle: pitchAngle || r.recommended_pitch_angle || null,
      };
    });

  merged.sort((a: any, b: any) => {
    const ms = (b.match_score ?? 0) - (a.match_score ?? 0);
    if (ms !== 0) return ms;
    return (b.follower_count ?? 0) - (a.follower_count ?? 0);
  });

  const results = merged.slice(0, MAX_RESULTS);
  for (const r of results) {
    const patch: Record<string, unknown> = {};
    if (lane) patch.lane = lane;
    if (r.why_it_fits) patch.why_it_fits = r.why_it_fits;
    if (r.recommended_pitch_angle) patch.recommended_pitch_angle = r.recommended_pitch_angle;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await supabase.from("playlist_targets").update(patch).eq("playlist_id", r.playlist_id);
    if (error) console.error("lane patch", r.playlist_id, error.message);
  }

  return {
    results,
    live_count: live.length,
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

    const { results, live_count } = await mergeCatalogAndLive(supabase, track_name, user_vibe, {
      lane,
      references,
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
      playlists,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return json({ error: true, message: msg }, 500);
  }
});
