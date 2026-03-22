import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};
const MAX_RESULTS = 20;
const LIVE_SEARCH_TERMS_MAX = 5;
const LIVE_SEARCH_BUDGET_MS = 3000;
function getHubKey(req: Request): string {
  return (req.headers.get("x-api-key") || req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
}
type PlaylistRow = {
  playlist_id: string; platform: string; playlist_name: string | null;
  curator_name: string | null; follower_count: number | null; track_count: number | null;
  overlap_score: number | null; fraud_score: number | null; fraud_verdict: string | null;
  pitch_status: string | null; research_context: Record<string, unknown> | null;
  tier: number | null; whitelist_status: boolean | null;
  vibe_tags: unknown; similar_artists: unknown;
  submission_method: string | null; submission_url: string | null;
  curator_email: string | null; is_active: boolean | null;
  match_score?: number; source?: "catalog" | "live";
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
  return new Set(vibe.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}
function detectGenreSignals(vibe: string): Record<string, boolean> {
  const v = vibe.toLowerCase();
  return {
    drill: /drill|fbg|g herbo|chicago drill|bando|opps/.test(v),
    spiritual: /spiritual|holistic|healing|meditation|conscious|mindful|native|flute/.test(v),
    westCoast: /west coast|cali|larry june|dom kennedy|la rap/.test(v),
    trap: /trap|808|banger|turn up/.test(v),
    underground: /underground|griselda|boldy|freddie gibbs|stove god/.test(v),
  };
}
function scoreRow(row: PlaylistRow, vibeTokens: Set<string>, trackTokens: Set<string>, genreSignals?: Record<string, boolean>): number {
  const tags = new Set([...normalizeTags(row.vibe_tags), ...normalizeTags(row.similar_artists)]);
  let s = 0;
  for (const t of vibeTokens) {
    if (tags.has(t)) s += 3;
    for (const tag of tags) { if (tag.includes(t) || t.includes(tag)) s += 1; }
  }
  for (const t of trackTokens) { if ((row.playlist_name ?? "").toLowerCase().includes(t)) s += 2; }
  s += Math.min(20, Math.floor((row.fraud_score ?? 0) / 5));
  if (row.whitelist_status) s += 15;
  if (row.tier === 1) s += 10; else if (row.tier === 2) s += 5;
  if (genreSignals) {
    const allTags = [...normalizeTags(row.vibe_tags), ...normalizeTags(row.similar_artists)].join(" ");
    if (genreSignals.drill && /drill|herbo|fbg|chicago/.test(allTags)) s += 15;
    if (genreSignals.spiritual && /spiritual|conscious|meditation|holistic/.test(allTags)) s += 15;
    if (genreSignals.westCoast && /west_coast|larry_june|dom_kennedy|cali/.test(allTags)) s += 15;
    if (genreSignals.trap && /trap|808/.test(allTags)) s += 10;
    if (genreSignals.underground && /griselda|underground|boldy|freddie/.test(allTags)) s += 10;
  }
  return s;
}
function followersLabel(row: PlaylistRow): string {
  if (row.follower_count != null) return row.follower_count.toLocaleString();
  if (row.submission_method === "algorithmic" || row.submission_method === "distributor_pitch") return "editorial";
  return "N/A";
}
export async function findPlaylistOpportunities(supabase: SupabaseClient, trackName: string, userVibe: string): Promise<PlaylistRow[]> {
  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);
  const genreSignals = detectGenreSignals(userVibe);
  const { data: cooling } = await supabase.from("pitch_log").select("playlist_id")
    .eq("track_name", trackName).gt("cooldown_until", new Date().toISOString());
  const excluded = new Set((cooling ?? []).map((r: any) => r.playlist_id));
  const { data: rows, error } = await supabase.from("playlist_targets")
    .select("playlist_id,platform,playlist_name,curator_name,follower_count,track_count,overlap_score,fraud_score,fraud_verdict,pitch_status,research_context,tier,whitelist_status,vibe_tags,similar_artists,submission_method,submission_url,curator_email,is_active")
    .eq("is_active", true).in("tier", [1, 2]).eq("fraud_verdict", "safe");
  if (error) throw new Error("playlist_targets: " + error.message);
  const scored = (rows ?? []).filter((r: any) => !excluded.has(r.playlist_id)).map((r: any) => ({
    ...r, match_score: scoreRow(r as PlaylistRow, vibeTokens, trackTokens, genreSignals), source: "catalog" as const,
  }));
  scored.sort((a: any, b: any) => { const ms = (b.match_score ?? 0) - (a.match_score ?? 0); return ms !== 0 ? ms : (b.follower_count ?? 0) - (a.follower_count ?? 0); });
  return scored.slice(0, MAX_RESULTS);
}
async function getSpotifyToken(): Promise<string | null> {
  const id = Deno.env.get("SPOTIFY_CLIENT_ID"), secret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!id || !secret) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(id + ":" + secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) return null;
  return (await res.json()).access_token ?? null;
}
function buildTerms(trackName: string, userVibe: string): string[] {
  const parts = [...tokenizeVibe(trackName), ...tokenizeVibe(userVibe)];
  const terms: string[] = [], seen = new Set<string>();
  for (const p of parts) { if (terms.length >= LIVE_SEARCH_TERMS_MAX) break; if (!seen.has(p)) { seen.add(p); terms.push(p); } }
  if (!terms.length && trackName) terms.push(trackName.slice(0, 40));
  return terms.slice(0, LIVE_SEARCH_TERMS_MAX);
}
type SpPl = { id: string; playlist_id: string; name: string; followers: number | null; owner: string | null };
async function liveSearch(token: string, terms: string[], budgetMs: number): Promise<SpPl[]> {
  const deadline = Date.now() + budgetMs, out: SpPl[] = [], seen = new Set<string>();
  for (const term of terms) {
    if (Date.now() > deadline) break;
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), Math.min(1200, deadline - Date.now()));
    try {
      const u = new URL("https://api.spotify.com/v1/search");
      u.searchParams.set("q", term); u.searchParams.set("type", "playlist"); u.searchParams.set("limit", "5");
      const res = await fetch(u.toString(), { headers: { Authorization: "Bearer " + token }, signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) continue;
      for (const pl of (await res.json()).playlists?.items ?? []) {
        if (!pl?.id) continue;
        const pid = "spotify:" + pl.id;
        if (seen.has(pid)) continue;
        seen.add(pid);
        out.push({ id: pl.id, playlist_id: pid, name: pl.name, followers: pl.followers?.total ?? null, owner: pl.owner?.display_name ?? null });
      }
    } catch { clearTimeout(to); }
  }
  return out;
}
async function upsertLive(supabase: SupabaseClient, items: SpPl[]): Promise<void> {
  for (const pl of items) {
    const { error } = await supabase.from("playlist_targets").upsert({
      playlist_id: pl.playlist_id, platform: "spotify", playlist_name: pl.name,
      curator_name: pl.owner, follower_count: pl.followers ?? 0, track_count: 0,
      overlap_score: 0, fraud_score: 50, fraud_verdict: "safe", pitch_status: "not_pitched",
      research_context: { source: "live_api", fetched_at: new Date().toISOString() },
      tier: 2, whitelist_status: false, vibe_tags: [], similar_artists: [],
      submission_url: "https://open.spotify.com/playlist/" + pl.id, is_active: true,
    }, { onConflict: "playlist_id" });
    if (error) console.error("upsert live", pl.playlist_id, error.message);
  }
}
export async function mergeCatalogAndLive(supabase: SupabaseClient, trackName: string, userVibe: string): Promise<{ results: PlaylistRow[]; live_count: number }> {
  const token = await getSpotifyToken();
  let live: SpPl[] = [];
  if (token) {
    const terms = buildTerms(trackName, userVibe);
    live = await liveSearch(token, terms, LIVE_SEARCH_BUDGET_MS);
    if (live.length) await upsertLive(supabase, live);
    console.log("live search: " + live.length + " playlists");
  }
  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);
  const genreSignals = detectGenreSignals(userVibe);
  const { data: mergedRows } = await supabase.from("playlist_targets")
    .select("playlist_id,platform,playlist_name,curator_name,follower_count,track_count,overlap_score,fraud_score,fraud_verdict,pitch_status,research_context,tier,whitelist_status,vibe_tags,similar_artists,submission_method,submission_url,curator_email,is_active")
    .eq("is_active", true).in("tier", [1, 2]).eq("fraud_verdict", "safe");
  const { data: cooling } = await supabase.from("pitch_log").select("playlist_id")
    .eq("track_name", trackName).gt("cooldown_until", new Date().toISOString());
  const excluded = new Set((cooling ?? []).map((r: any) => r.playlist_id));
  const merged = (mergedRows ?? []).filter((r: any) => !excluded.has(r.playlist_id)).map((r: any) => ({
    ...r,
    match_score: scoreRow(r as PlaylistRow, vibeTokens, trackTokens, genreSignals),
    source: ((r.research_context as any)?.source === "live_api" ? "live" : "catalog") as "catalog" | "live",
  }));
  merged.sort((a: any, b: any) => { const ms = (b.match_score ?? 0) - (a.match_score ?? 0); return ms !== 0 ? ms : (b.follower_count ?? 0) - (a.follower_count ?? 0); });
  return { results: merged.slice(0, MAX_RESULTS), live_count: live.length };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) return json({ error: "Unauthorized" }, 401);
    const supabase = getServiceClient();
    const body = await req.json().catch(() => ({}));
    const track_name = String(body.track_name ?? body.trackName ?? "").trim();
    const user_vibe = String(body.user_vibe ?? body.userVibe ?? body.vibe ?? "").trim();
    if (!track_name) return json({ error: "track_name required" }, 400);
    const { results, live_count } = await mergeCatalogAndLive(supabase, track_name, user_vibe);
    return json({
      ok: true, track_name, user_vibe, count: results.length, live_api_ingested: live_count,
      playlists: results.map(r => ({
        playlist_id: r.playlist_id,
        name: r.playlist_name,
        followers: r.follower_count,
        followers_label: followersLabel(r),
        platform: r.platform,
        bot_score: r.fraud_score,
        curator_email: r.curator_email,
        submission_url: r.submission_url,
        submission_method: r.submission_method,
        tier: r.tier,
        match_score: r.match_score,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return json({ error: true, message: msg }, 500);
  }
});
