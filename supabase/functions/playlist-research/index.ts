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
  isSweepLane,
  laneRegexBoost,
  loadLanesConfig,
  rowMatchesLane,
  scoreLaneBoost,
} from "../_shared/playlist-lanes.ts";
import {
  scrapeSpotifyPlaylistDetail,
  scrapeSpotifySearchPlaylists,
  scrapeSpotifyUserProfile,
  type SpotifyPlaylistStub,
  type SpotifyUserProfile,
} from "../_shared/spotify-scrape.ts";
import { firecrawlMarkdown, firecrawlSearch } from "../_shared/firecrawl.ts";
import {
  buildBalancedSweepQueries,
  buildDiscoveryQueries,
  computeRotation,
  dedupeStubs,
  extractPlaylistIdsFromText,
  HOUSE_SUBGENRES,
  mapPool,
  RAP_SUBGENRES,
  type SearchHitLike,
  selectHarvestUrls,
  SWEEP_MODIFIERS,
} from "../_shared/discovery-utils.ts";
import {
  BOT_RISK_THRESHOLD,
  classifyFeel,
  CLASSIFIER_VERSION,
  computeBotRisk,
  enrichmentOutcome,
  isClassifierStale,
  laneForSweep,
  type SweepGenre,
  SWEEP_SOURCE,
} from "../_shared/playlist-sweep.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const MAX_RESULTS = 20;
// Scrape budget measured from the start of mergeCatalogAndLive, NOT 55s. The edge
// wall is ~55s; we stop all scraping at 40s so the post-discovery DB work (upserts,
// re-query, merge, lane patches) finishes and we return partial-but-FRESH results
// before the wall instead of being killed mid-flight and returning the stale set.
// Tightened from 45s → 40s: the scrapes now run concurrently (see SCRAPE_CONCURRENCY),
// so the work finishes well inside this ceiling and the deadline is a safety net.
const SCRAPE_BUDGET_MS = 40_000;
// How many Firecrawl scrapes run in flight at once. Each scrape is independent
// network I/O, so fanning them out instead of awaiting one-at-a-time is the main
// speed win. Kept modest so we don't trip Firecrawl's per-plan rate limits.
const SCRAPE_CONCURRENCY = 6;
// Capped discovery breadth: enough seed queries for variety, small enough that the
// deadline guard isn't the only thing keeping us under budget. The per-request
// Firecrawl timeout (see firecrawl.ts) bounds any single hung scrape.
const SEARCH_REF_CAP_FULL = 14;
const STUBS_PER_REF_FULL = 10;
const DETAIL_CAP_FULL = 18;
const SEARCH_REF_CAP_QUICK = 6;
const STUBS_PER_REF_QUICK = 8;
const DETAIL_CAP_QUICK = 12;
// Penalty applied in the final merge to playlists pitched in the last 90 days, so a
// run surfaces NEW curators at the top instead of re-returning the exhausted set.
// Large enough to sink any pitched row below every un-pitched one (they still appear
// further down if there aren't enough fresh results to fill MAX_RESULTS).
const RECENTLY_PITCHED_PENALTY = 1000;
// Mass-sweep breadth. The genre × modifier cross-product is large; SWEEP_QUERY_CAP
// bounds how many of those queries a single run actually issues (rotated per run so
// successive sweeps cover the rest). DETAIL_CAP_SWEEP bounds the follow-up detail
// scrapes. Both sized to stay inside SCRAPE_BUDGET_MS at SCRAPE_CONCURRENCY without
// tripping Firecrawl rate limits — widen only if you also raise the budget.
// Widened from 24 → 40. The balanced builder (buildBalancedSweepQueries) now packs
// far more DISTINCT subgenres per run — one modifier pass covers every subgenre —
// and splits the budget rap/house, so a bigger cap buys real breadth instead of a
// deeper orbit of one subgenre. 40 queries × 1 web-search each stays inside the
// SEARCH half of SCRAPE_BUDGET_MS at SCRAPE_CONCURRENCY; the deadline guard backstops.
const SWEEP_QUERY_CAP = 60;
const DETAIL_CAP_SWEEP = 24;
// Hit-page harvest — the discovery-VOLUME lever. The bare web-search channel only
// sees playlist ids that appear in a hit's url/title/description (~1 id/query, which
// is why 40 queries deduped to ~17). The listicle / directory / roundup PAGES those
// searches return embed dozens of open.spotify.com/playlist links in their body.
// After the search fan-out we scrape up to HARVEST_PAGE_CAP of the most promising
// third-party pages (selectHarvestUrls) and extract ids from the full markdown —
// 10-30× the distinct-id yield per query. Bounded + deadline-guarded so a slow
// harvest degrades gracefully (returns what it got) and never blows the edge wall.
const HARVEST_PAGE_CAP = 16;
// Extra fresh stubs a sweep persists as `enriched:false` pending rows BEYOND the
// enrichment batch (DETAIL_CAP_SWEEP). Discovery now surfaces more ids than one run
// can enrich; instead of dropping the overflow, we bank it so the library — the
// BUFFER Fendi wants far larger than his daily sends — grows every run and the
// backlog drains via loadUnenrichedSweepRows on later runs. Bounded so a single run
// can't balloon the pending set.
const PERSIST_STUB_CAP = 250;
// Fraction of SCRAPE_BUDGET_MS reserved for the SEARCH phase; the remainder is
// guaranteed to the ENRICHMENT (detail-scrape) phase. Without this split a wide
// sweep's 24-query × 2-channel search consumed the whole window, so the detail
// phase's deadline guard tripped immediately and NOTHING got enriched — rows
// landed with placeholder names, 0 followers, and a false bot_risk. Half-and-half
// leaves ~20s for ~24 detail scrapes at SCRAPE_CONCURRENCY (≈4 rounds).
const SEARCH_BUDGET_FRACTION = 0.5;
// How many previously-un-enriched sweep rows a run pulls back from the DB to retry
// enrichment on. Bounded so re-enrichment + fresh discovery together stay inside
// DETAIL_CAP_SWEEP and the scrape budget. Draining this backlog is what makes the
// sweep idempotent: rows left `enriched:false` by an earlier run get completed
// later instead of remaining empty stubs forever.
const REENRICH_CAP_SWEEP = 16;
// How many already-enriched sweep rows a run re-classifies when their stored
// classifier_version is older than the current CLASSIFIER_VERSION (or their label
// predates the classifier_version stamp entirely). This is pure DB work — no
// scraping — so it's cheap and the cap can be generous; the rest catch up on the
// next run. Idempotent: re-running with the same version is a no-op. Without this,
// every classifier improvement freezes previously-labeled rows at their stale
// label forever (the "compounding at scale" failure across 200+ playlists).
const RECLASSIFY_CAP_SWEEP = 200;
// How many already-enriched sweep rows a run re-scrapes to back-fill featuring_tracks
// (the placement/silent-add signal). Unlike RECLASSIFY_CAP_SWEEP this is NOT pure DB
// work — every row costs a live embed fetch — so the cap is small and in the same
// ballpark as REENRICH_CAP_SWEEP. The backlog (~213 rows) drains over successive runs
// rather than in one hammering burst; each row is attempted at most once.
const BACKFILL_FEATURING_CAP_SWEEP = 12;
// Web-search hits fetched per discovery query. The Spotify search *page* scrape is
// a client-rendered SPA that returns no crawlable playlist anchors, so discovery
// leans on this web-search channel (same one placement-discovery uses) to surface
// playlist ids from third-party pages.
const SEARCH_HITS_PER_QUERY = 20;
// Channel A — the direct scrape of open.spotify.com/search/<q>/playlists — returns 0
// on EVERY run (it's a client-rendered SPA with no crawlable playlist anchors), so it
// is disabled by default and discovery leans entirely on the web-search channel. Not
// deleted: set DISCOVERY_ENABLE_SEARCH_SCRAPE=true to revive it if Spotify ever
// server-renders the search page again. Left behind a flag rather than removed silently.
const ENABLE_SEARCH_PAGE_SCRAPE =
  (Deno.env.get("DISCOVERY_ENABLE_SEARCH_SCRAPE") ?? "").toLowerCase() === "true";
type DiscoverySkips = {
  disclaim_brand: number;
  casual_user: number;
  micro_playlist: number;
  artist_as_curator: number;
  spotify_owned: number;
  high_bot_risk: number;
};

/** Search-phase funnel counters, surfaced in the response so a zero/empty run is
 * diagnosable without log access. */
type DiscoveryFunnel = {
  queries: number;
  raw_scrape: number;
  raw_websearch: number;
  /** Playlist ids harvested from scraped hit PAGES (listicles/directories), the
   * high-yield discovery channel layered on top of raw_websearch. */
  raw_harvest: number;
  /** How many hit pages the harvest pass actually scraped this run. */
  harvest_pages: number;
  unique_after_dedupe: number;
  skipped_recent: number;
};

/** Full funnel = discovery + enrichment outcome, returned in the response body. */
type SweepFunnel = DiscoveryFunnel & {
  enriched_ok: number;
  enrich_failed: number;
  /** reason → count for every row that did NOT enrich, so a future failure is
   * legible from the response body alone (e.g. {no_metadata: 3, not_attempted: 2}). */
  enrich_failed_reasons: Record<string, number>;
  /** Idempotent back-fill of PRIOR runs' `enriched:false` stubs (a subset of the
   * enrichment batch). `considered` = how many stubs this run pulled from the DB
   * backlog; ok/failed = how many of those the detail scrape completed vs. attempted
   * but failed. Leftovers (never reached before the budget expired) are neither and
   * get retried next run. */
  backfill_considered: number;
  backfilled_ok: number;
  backfill_failed: number;
  /** Back-fill rows whose embed returned NO entity (deleted/private/region-locked):
   * counted honestly as `backfill_dead` instead of inflating `backfilled_ok`, and
   * marked `enrich_status:'dead'` so they're excluded from future back-fill retries
   * rather than re-attempted forever. */
  backfill_dead: number;
  /** Idempotent re-classification of ALREADY-enriched sweep rows whose stored
   * classifier_version is stale (or absent). `reclassified_count` = rows considered
   * this run; `reclassified_ok` = rows whose category/confidence/reason actually
   * changed and were updated in place. This is what un-freezes labels applied by an
   * older classifier build (root cause #1). */
  reclassified_count: number;
  reclassified_ok: number;
  /** Bounded re-scrape back-fill of `featuring_tracks` (the placement/silent-add
   * signal) onto already-enriched sweep rows that predate track-title capture.
   * `featuring_backfill_considered` = rows attempted this run (each row is attempted
   * at most once, ever); `featuring_backfill_ok` = rows where the re-scrape actually
   * returned titles. The gap between them is rows whose embed yielded no tracklist —
   * they are stamped and dropped from the backlog, NOT retried. */
  featuring_backfill_considered: number;
  featuring_backfill_ok: number;
  /** Honest write accounting. `new_created` = rows that TRULY landed this run
   * (reconciled against created_at), the number `new_this_run` reports. `upsert_errors`
   * = per-row upsert failures (previously swallowed) — the gap between the pre-write
   * candidate count and rows actually created. `stubs_persisted` = overflow fresh
   * stubs banked as pending rows beyond the enrichment batch (buffer growth). */
  new_created: number;
  upsert_errors: number;
  stubs_persisted: number;
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
  track_count?: number | null;
  _track_artists?: string[];
  _track_titles?: string[];
  // Whether the detail scrape populated this row. `false` until enrichment
  // succeeds; drives bot-risk deferral (no false penalties on absent fields) and
  // the idempotent re-enrichment backlog.
  enriched?: boolean;
  // De-bot + feel signals, computed in filterDiscoveryCandidates and persisted to
  // research_context by upsertLiveResults. `bot_risk` is null while enrichment is
  // pending (never a fabricated score from missing data).
  bot_risk?: number | null;
  category?: string;
  category_confidence?: number;
  // Coarse rap/house genre from the classifier — drives the sweep-lane stamp
  // (laneForSweep) so a sweep row lands in a countable rap/house lane.
  category_genre?: SweepGenre;
  // Short note on what matched (or why it stayed neutral/uncategorized) — persisted
  // to research_context so a misclassification is debuggable from the row alone.
  category_reason?: string;
  // Transient: why enrichment did not produce a real name this run (for the funnel's
  // enrich_failed_reasons). Not persisted.
  _enrich_reason?: string;
  // Terminal enrichment verdict, persisted to research_context. Set to "dead" when
  // the embed returns NO entity (deleted/private/region-locked playlist) so the row
  // is excluded from future back-fill retries instead of being re-scraped forever.
  enrich_status?: "dead";
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
  return src === "spotify_web" || src === "live_api" || src === SWEEP_SOURCE;
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
  recentlyPitchedPenalty = 0,
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
  return s + extraLaneScore - curatorQualityPenalty(row) - recentlyPitchedPenalty;
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

const EMPTY_FUNNEL: DiscoveryFunnel = {
  queries: 0,
  raw_scrape: 0,
  raw_websearch: 0,
  raw_harvest: 0,
  harvest_pages: 0,
  unique_after_dedupe: 0,
  skipped_recent: 0,
};

/**
 * Search phase only — harvest playlist stubs from the two discovery channels and
 * dedupe them. Enrichment (the detail scrape that fills name/curator/followers/
 * track_count/description) is a SEPARATE step (`enrichPlaylists`) with its own
 * reserved slice of the scrape budget, so a wide sweep's search can't starve it.
 * Returned stubs carry `enriched: false` until that step runs.
 */
async function discoverViaSpotifyWeb(
  references: string[],
  lane: string,
  quick = false,
  excludeIds: Set<string> = new Set(),
  deadline: number = Date.now() + SCRAPE_BUDGET_MS,
  rotation: number = Math.floor(Date.now() / 86_400_000),
  queryOverride?: string[],
): Promise<{ items: DiscoveredPlaylist[]; funnel: DiscoveryFunnel }> {
  const refCap = quick ? SEARCH_REF_CAP_QUICK : SEARCH_REF_CAP_FULL;
  const stubsPerRef = quick ? STUBS_PER_REF_QUICK : STUBS_PER_REF_FULL;

  // Sweep mode supplies a pre-built genre × modifier query set; otherwise build the
  // usual lane + reference-artist queries.
  const queries = queryOverride ?? buildDiscoveryQueries(references, lane, refCap, rotation);

  if (!queries.length) {
    console.warn("[playlist-research] no references or lane for web discovery");
    return { items: [], funnel: { ...EMPTY_FUNNEL } };
  }

  if (!Deno.env.get("FIRECRAWL_API_KEY")) {
    console.error("[playlist-research] FIRECRAWL_API_KEY not set — skipping web discovery");
    return { items: [], funnel: { ...EMPTY_FUNNEL, queries: queries.length } };
  }

  const seen = new Set<string>();
  const out: DiscoveredPlaylist[] = [];
  const log: { query: string; count: number; ok: boolean }[] = [];
  let skippedRecent = 0;
  // Funnel counters — raw stub yield per channel BEFORE dedupe. Emitted below so a
  // zero-result run is diagnosable instead of silently falling through to catalog.
  let rawScrape = 0;
  let rawWebSearch = 0;

  // Search phase — fan the queries out `SCRAPE_CONCURRENCY`-at-a-time. Each query
  // pulls from TWO channels: the Spotify search-page scrape (Channel A) AND a
  // Firecrawl web search that harvests playlist ids from third-party pages
  // (Channel B). Channel A alone returns nothing for broad genre sweeps — the
  // search page is a client-rendered SPA with no crawlable playlist anchors — so
  // Channel B is what actually surfaces playlists (it's the channel that already
  // works in placement-discovery). mapPool preserves order so dedupe stays
  // deterministic.
  const stubLists = await mapPool(
    queries,
    SCRAPE_CONCURRENCY,
    async (query) => {
      const stubs: SpotifyPlaylistStub[] = [];
      let hits: SearchHitLike[] = [];
      let ok = false;
      // Channel A — scrape Spotify's own search page. Disabled by default (returns 0
      // every run; see ENABLE_SEARCH_PAGE_SCRAPE) so the wasted scrape budget goes to
      // Channel B / enrichment instead.
      if (ENABLE_SEARCH_PAGE_SCRAPE) {
        try {
          const scraped = await scrapeSpotifySearchPlaylists(query);
          rawScrape += scraped.length;
          stubs.push(...scraped);
          ok = true;
        } catch (e) {
          console.error(`[discover] search-scrape "${query}" failed:`, e instanceof Error ? e.message : String(e));
        }
      }
      // Channel B — web search → harvest playlist ids. Names/owners are backfilled
      // by the detail phase below, so a placeholder name here is fine. The raw `hits`
      // are also returned so the hit-page harvest below can scrape the article/directory
      // pages (which embed far more playlist links than the hit metadata alone).
      try {
        hits = await firecrawlSearch(query, SEARCH_HITS_PER_QUERY);
        const blob = hits.map((h) => `${h.url}\n${h.title ?? ""}\n${h.description ?? ""}`).join("\n");
        const ids = extractPlaylistIdsFromText(blob);
        rawWebSearch += ids.length;
        for (const id of ids) stubs.push({ playlist_id: id, name: `Playlist ${id.slice(0, 6)}…` });
        ok = true;
      } catch (e) {
        console.error(`[discover] web-search "${query}" failed:`, e instanceof Error ? e.message : String(e));
      }
      return { query, stubs, hits, ok };
    },
    () => Date.now() > deadline,
  );

  for (const res of stubLists) {
    if (!res) continue;
    const { freshIds, skippedRecent: skipped } = dedupeStubs(
      res.stubs.slice(0, stubsPerRef),
      seen,
      excludeIds,
    );
    skippedRecent += skipped;
    const stubById = new Map(res.stubs.map((s) => [`spotify:${s.playlist_id}`, s]));
    for (const pid of freshIds) {
      const s = stubById.get(pid)!;
      out.push({
        id: s.playlist_id,
        playlist_id: pid,
        name: s.name,
        followers: null,
        owner: s.owner_name ?? null,
        owner_id: s.owner_id,
        track_count: null,
        // Stubs are unenriched by definition — the detail scrape hasn't run yet.
        enriched: false,
      });
    }
    log.push({ query: res.query, count: freshIds.length, ok: res.ok });
  }

  // ── Hit-page harvest ──────────────────────────────────────────────────────
  // The real discovery-VOLUME lever. Scrape the most promising third-party pages
  // the searches surfaced (listicles / curator directories / roundups) and pull the
  // many open.spotify.com/playlist links embedded in their bodies — 10-30× the
  // distinct-id yield of reading hit metadata alone. Bounded by HARVEST_PAGE_CAP and
  // the SEARCH deadline, failures swallowed, so worst case it adds nothing and never
  // blows the wall.
  let rawHarvest = 0;
  let harvestPages = 0;
  const allHits: SearchHitLike[] = [];
  for (const res of stubLists) if (res) allHits.push(...res.hits);
  const harvestUrls = selectHarvestUrls(allHits, HARVEST_PAGE_CAP);
  if (harvestUrls.length && Date.now() < deadline) {
    const harvestResults = await mapPool(
      harvestUrls,
      SCRAPE_CONCURRENCY,
      async (url) => {
        try {
          const md = await firecrawlMarkdown(url);
          return extractPlaylistIdsFromText(md);
        } catch (e) {
          console.error(`[discover] harvest "${url}" failed:`, e instanceof Error ? e.message : String(e));
          return [] as string[];
        }
      },
      () => Date.now() > deadline,
    );
    const harvestStubs: SpotifyPlaylistStub[] = [];
    for (const ids of harvestResults) {
      if (!ids) continue; // deadline-skipped slot
      harvestPages++;
      for (const id of ids) {
        rawHarvest++;
        harvestStubs.push({ playlist_id: id, name: `Playlist ${id.slice(0, 6)}…` });
      }
    }
    // Dedupe harvested ids against everything already collected this run (mutates
    // `seen`), then append the fresh ones as unenriched stubs — the detail phase
    // backfills real name/curator/followers just like any other discovered stub.
    const { freshIds } = dedupeStubs(harvestStubs, seen, excludeIds);
    const byId = new Map(harvestStubs.map((s) => [`spotify:${s.playlist_id}`, s]));
    for (const pid of freshIds) {
      const s = byId.get(pid)!;
      out.push({
        id: s.playlist_id,
        playlist_id: pid,
        name: s.name,
        followers: null,
        owner: null,
        track_count: null,
        enriched: false,
      });
    }
    console.log(`[playlist-research] harvest: ${harvestPages} pages → ${rawHarvest} raw ids → ${freshIds.length} fresh`);
  }

  const funnel: DiscoveryFunnel = {
    queries: queries.length,
    raw_scrape: rawScrape,
    raw_websearch: rawWebSearch,
    raw_harvest: rawHarvest,
    harvest_pages: harvestPages,
    unique_after_dedupe: out.length,
    skipped_recent: skippedRecent,
  };
  console.log(
    "[playlist-research] web discover funnel:",
    JSON.stringify(funnel),
    "per_query:", JSON.stringify(log),
  );
  return { items: out, funnel };
}

/** True when a name is one of the placeholder stubs we mint from a playlist id
 * ("Playlist 0KLdaP…" / "Playlist 0KLdaP12") — i.e. NOT real curated metadata. */
function isPlaceholderName(name: string | null | undefined): boolean {
  return /^Playlist\s+[a-zA-Z0-9]{4,8}(…|\.{3})?$/.test((name ?? "").trim());
}

/**
 * Enrichment phase — run the detail scrape over `items` (in place), filling real
 * name/curator/followers/track_count/description. Concurrency- and budget-bounded:
 * `mapPool` stops launching scrapes once `deadline` passes, so items it never
 * reached keep `enriched: false` and are persisted for a later run to finish
 * (idempotent — same playlist_id, no duplicate row). Sets `pl.enriched = true`
 * ONLY when the scrape returned genuine metadata (a real name, a follower count,
 * or track artists) — a placeholder-only fallback stays `enriched: false` so the
 * bot scorer doesn't fabricate a score from it.
 */
async function enrichPlaylists(
  items: DiscoveredPlaylist[],
  deadline: number,
): Promise<{ enriched_ok: number; enrich_failed: number; enrich_failed_reasons: Record<string, number> }> {
  await mapPool(
    items,
    SCRAPE_CONCURRENCY,
    async (pl) => {
      try {
        const detail = await scrapeSpotifyPlaylistDetail(pl.id);
        // A row is enriched ONLY if we recovered a real playlist name (not the
        // "Playlist <id>" stub). Follower count is intentionally NOT sufficient:
        // the embed page never carries it, so followers stay null and must never
        // flip a row to "enriched" (and never default to 0 → no phantom bot_risk).
        const gotRealName = !!detail?.name && !isPlaceholderName(detail.name);
        if (detail) {
          if (detail.name && !isPlaceholderName(detail.name)) pl.name = detail.name;
          if (detail.description != null) pl.description = detail.description;
          if (detail.follower_count != null) pl.followers = detail.follower_count;
          if (detail.track_count != null) pl.track_count = detail.track_count;
          if (detail.owner_name) pl.owner = detail.owner_name;
          if (detail.owner_id) pl.owner_id = detail.owner_id;
          if (detail.track_artists) pl._track_artists = detail.track_artists;
          if (detail.track_titles) pl._track_titles = detail.track_titles;
        }
        // Single source of truth for the verdict (pure + unit-tested): real name →
        // enriched; entity-but-no-name → retryable; NO entity → terminally dead
        // (deleted/private/region-locked), so loadUnenrichedSweepRows stops pulling it
        // back every run.
        const verdict = enrichmentOutcome(!!detail, gotRealName);
        pl.enriched = verdict.enriched;
        pl._enrich_reason = verdict.enriched ? undefined : verdict.reason;
        if (verdict.dead) pl.enrich_status = "dead";
      } catch (e) {
        pl.enriched = false;
        pl._enrich_reason = "exception";
        console.error(`[discover] detail ${pl.id} failed:`, e instanceof Error ? e.message : String(e));
      }
      return null;
    },
    () => Date.now() > deadline,
  );

  items.sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0));
  const enriched_ok = items.filter((p) => p.enriched === true).length;
  // Tally why each unenriched row failed. Rows the budget never reached were never
  // assigned a reason → "not_attempted" (they persist as stubs for the next run).
  const enrich_failed_reasons: Record<string, number> = {};
  for (const pl of items) {
    if (pl.enriched === true) continue;
    const reason = pl._enrich_reason ?? "not_attempted";
    enrich_failed_reasons[reason] = (enrich_failed_reasons[reason] ?? 0) + 1;
  }
  return { enriched_ok, enrich_failed: items.length - enriched_ok, enrich_failed_reasons };
}

/**
 * Load previously-discovered sweep rows still flagged `enriched:false` so this run
 * can retry their detail scrape. This is what makes the sweep idempotent: a run
 * whose budget expired mid-enrichment leaves rows pending, and a later run drains
 * them here — re-scraped, re-scored, re-classified, and re-upserted on the same
 * playlist_id (no duplicate). Returns them as DiscoveredPlaylist stubs.
 */
async function loadUnenrichedSweepRows(
  supabase: SupabaseClient,
  cap: number,
): Promise<DiscoveredPlaylist[]> {
  try {
    const { data, error } = await supabase
      .from("playlist_targets")
      .select("playlist_id, playlist_name, curator_name, follower_count, research_context")
      .eq("research_context->>source", SWEEP_SOURCE)
      // A row is un-enriched when the flag is explicitly "false" OR absent entirely.
      // The absent case is the bug this fixes: the 5 pre-existing stubs were written
      // by a build that never set research_context.enriched, so `->>enriched` is NULL
      // for them and the old `.eq(..., "false")` filter matched zero of them, leaving
      // them stranded as "Playlist 0KLdaP…" stubs forever. `is.null` catches those.
      .or("research_context->>enriched.eq.false,research_context->>enriched.is.null")
      // Exclude terminally-dead rows (embed returned no entity — deleted/private/
      // region-locked). Their `enrich_status` is "dead"; keep everything whose
      // status is absent OR anything other than "dead". Without the explicit
      // `is.null` arm a bare `.neq(..., "dead")` would drop every row whose
      // enrich_status is NULL (SQL: NULL <> 'dead' → NULL, not true) — i.e. all the
      // still-retryable rows. This arm is what stops dead stubs being retried forever.
      .or("research_context->>enrich_status.is.null,research_context->>enrich_status.neq.dead")
      .limit(cap);
    if (error) {
      console.error("[playlist-research] loadUnenrichedSweepRows:", error.message);
      return [];
    }
    return (data ?? []).map((r: {
      playlist_id: string;
      playlist_name: string | null;
      curator_name: string | null;
      follower_count: number | null;
      research_context: Record<string, unknown> | null;
    }) => {
      const rc = r.research_context ?? {};
      const rawId = String(r.playlist_id).replace(/^spotify:/, "");
      return {
        id: rawId,
        playlist_id: r.playlist_id,
        name: r.playlist_name ?? `Playlist ${rawId.slice(0, 6)}…`,
        followers: r.follower_count ?? null,
        owner: r.curator_name ?? null,
        owner_id: (rc.spotify_owner_id as string | undefined) ?? undefined,
        track_count: null,
        enriched: false,
      } as DiscoveredPlaylist;
    });
  } catch (e) {
    console.error("[playlist-research] loadUnenrichedSweepRows failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Root-cause-#1 fix — idempotent RE-CLASSIFICATION of already-enriched sweep rows.
 *
 * Previously, when the classifier improved, only NEW rows benefited: rows classified
 * by an older build stayed frozen at their stale label forever (the `reason=None`
 * mislabels: "Hip Hop: Essentials" → late_night_chill, "RAP MUSIC 2026" →
 * uncategorized). At 200+ playlists that compounds — each row is stuck at whatever
 * the classifier knew the day it landed.
 *
 * This pass pulls enriched sweep rows whose stored `classifier_version` is stale
 * (older than CLASSIFIER_VERSION) or absent (never stamped — the pre-version rows),
 * re-runs the CURRENT classifier over the already-stored name + description + track
 * data, and updates category/category_confidence/category_reason + classifier_version
 * IN PLACE on the same row. Budget-bounded by `cap` (the rest catch up next run) and
 * by `deadline`. Fully idempotent: a row already at CLASSIFIER_VERSION is never
 * selected, and re-running yields the same label.
 */
async function reclassifySweepRows(
  supabase: SupabaseClient,
  cap: number,
  deadline: number,
): Promise<{ reclassified_count: number; reclassified_ok: number }> {
  const curV = String(CLASSIFIER_VERSION);
  let rows: Array<{ playlist_id: string; playlist_name: string | null; lane: string | null; research_context: Record<string, unknown> | null }> = [];
  try {
    const { data, error } = await supabase
      .from("playlist_targets")
      .select("playlist_id, playlist_name, lane, research_context")
      .eq("research_context->>source", SWEEP_SOURCE)
      // Never re-classify a terminally-dead row (no real metadata to classify).
      .or("research_context->>enrich_status.is.null,research_context->>enrich_status.neq.dead")
      // Exclude still-PENDING stubs (enriched explicitly "false"): they have no real
      // metadata yet and would otherwise consume the cap without producing a label.
      // Keep rows where enriched is "true" OR absent (null) — old real rows written by
      // a build that predates the `enriched` flag still have real names to classify.
      .or("research_context->>enriched.is.null,research_context->>enriched.neq.false")
      // Stale = never stamped (null — the old `reason=None` rows) OR a version other
      // than the current one. Since the version only ever increases, `neq` current
      // means "older build". This is the trigger that un-freezes stale labels.
      .or(`research_context->>classifier_version.is.null,research_context->>classifier_version.neq.${curV}`)
      .limit(cap);
    if (error) {
      console.error("[playlist-research] reclassifySweepRows query:", error.message);
      return { reclassified_count: 0, reclassified_ok: 0 };
    }
    rows = data ?? [];
  } catch (e) {
    console.error("[playlist-research] reclassifySweepRows failed:", e instanceof Error ? e.message : e);
    return { reclassified_count: 0, reclassified_ok: 0 };
  }

  let considered = 0;
  let ok = 0;
  await mapPool(
    rows,
    SCRAPE_CONCURRENCY,
    async (r) => {
      const rc = r.research_context ?? {};
      const name = r.playlist_name ?? "";
      // Skip placeholder stubs — they carry no real metadata to classify (and are
      // handled by the enrichment back-fill, not here).
      if (!name || isPlaceholderName(name)) return null;
      // Belt-and-suspenders: only touch rows the shared staleness rule agrees are
      // stale (guards against any query-filter quirk re-writing current-version rows).
      if (!isClassifierStale(rc.classifier_version as number | string | null | undefined)) return null;
      considered++;
      const description = (rc.classifier_description as string | null) ?? null;
      const artists = Array.isArray(rc.classifier_track_artists) ? (rc.classifier_track_artists as string[]) : [];
      const titles = Array.isArray(rc.classifier_track_titles) ? (rc.classifier_track_titles as string[]) : [];
      const feel = classifyFeel(name, description, artists, titles);
      const nextRc = {
        ...rc,
        category: feel.category,
        category_confidence: feel.confidence,
        category_reason: feel.reason,
        category_genre: feel.genre,
        classifier_version: CLASSIFIER_VERSION,
      };
      // Back-fill the lane too: this is what turns the ~100 NULL-lane sweep rows
      // (ingested before the sweep stamped lanes) into countable rap/house lanes.
      // Only override the lane on sweep rows whose current lane is empty or is itself
      // a sweep lane — never clobber a hand-set/config lane. Null genre → leave unlaned.
      const derivedLane = laneForSweep(feel.category, feel.genre);
      const curLane = String((r as { lane?: string | null }).lane ?? "").trim();
      const update: Record<string, unknown> = { research_context: nextRc };
      if (derivedLane && derivedLane !== curLane && (curLane === "" || isSweepLane(curLane))) {
        update.lane = derivedLane;
      }
      const { error } = await supabase
        .from("playlist_targets")
        .update(update)
        .eq("playlist_id", r.playlist_id);
      if (error) {
        console.error("[playlist-research] reclassify update", r.playlist_id, error.message);
        return null;
      }
      ok++;
      return null;
    },
    () => Date.now() > deadline,
  );

  return { reclassified_count: considered, reclassified_ok: ok };
}

/**
 * Bounded back-fill of `featuring_tracks` onto ALREADY-ENRICHED sweep rows.
 *
 * The sweep now writes featuring_tracks from the scraped embed titles (see the upsert
 * in enrichPlaylists), but rows swept BEFORE track titles were captured are enriched
 * and carry an EMPTY classifier_track_titles — there is no stored copy of the titles
 * to copy across. So this is a genuine RE-SCRAPE, not a key rename: without it those
 * rows stay invisible to silent-add detection forever, because the retry path
 * (loadUnenrichedSweepRows) only ever revisits `enriched:false` rows.
 *
 * Bounded and gentle by construction:
 *  - `cap` rows per run (the backlog drains over subsequent runs), plus a `deadline`.
 *  - Runs at SCRAPE_CONCURRENCY through mapPool, same as every other scrape phase.
 *  - Each row is attempted AT MOST ONCE: `featuring_backfill_at` is stamped whether or
 *    not titles came back, and the query skips any stamped row. A playlist whose embed
 *    yields nothing is therefore never re-hit — that's what keeps this from hammering
 *    Spotify on a permanently-empty backlog.
 *
 * Idempotent: rows that already have featuring_tracks, or that have been attempted,
 * are not selected; re-running is a no-op once the backlog is drained.
 */
async function backfillFeaturingTracks(
  supabase: SupabaseClient,
  cap: number,
  deadline: number,
): Promise<{ featuring_backfill_considered: number; featuring_backfill_ok: number }> {
  let rows: Array<{ playlist_id: string; research_context: Record<string, unknown> | null }> = [];
  try {
    const { data, error } = await supabase
      .from("playlist_targets")
      .select("playlist_id, research_context")
      .eq("research_context->>source", SWEEP_SOURCE)
      // Dead rows (no embed entity at all) can never yield a tracklist.
      .or("research_context->>enrich_status.is.null,research_context->>enrich_status.neq.dead")
      // Enriched rows only — a pending stub is the retry path's job, not ours, and it
      // will pick up featuring_tracks through the normal upsert once it enriches.
      .or("research_context->>enriched.is.null,research_context->>enriched.neq.false")
      // Nothing to do if the bridge (or placement discovery) already populated it.
      .is("research_context->>featuring_tracks", null)
      // Attempt-once guard — see the doc comment.
      .is("research_context->>featuring_backfill_at", null)
      .limit(cap);
    if (error) {
      console.error("[playlist-research] backfillFeaturingTracks query:", error.message);
      return { featuring_backfill_considered: 0, featuring_backfill_ok: 0 };
    }
    rows = data ?? [];
  } catch (e) {
    console.error("[playlist-research] backfillFeaturingTracks failed:", e instanceof Error ? e.message : e);
    return { featuring_backfill_considered: 0, featuring_backfill_ok: 0 };
  }

  let considered = 0;
  let ok = 0;
  await mapPool(
    rows,
    SCRAPE_CONCURRENCY,
    async (r) => {
      considered++;
      const rc = r.research_context ?? {};
      const rawId = String(r.playlist_id).replace(/^spotify:/, "");
      let titles: string[] = [];
      try {
        const detail = await scrapeSpotifyPlaylistDetail(rawId);
        titles = detail?.track_titles ?? [];
      } catch (e) {
        console.error("[playlist-research] backfill scrape", r.playlist_id, e instanceof Error ? e.message : e);
      }
      // Stamp the attempt even when the scrape yielded nothing, so this row drops out
      // of the backlog instead of being re-scraped every run.
      const nextRc: Record<string, unknown> = {
        ...rc,
        featuring_backfill_at: new Date().toISOString(),
      };
      if (titles.length) {
        // Same partial-preview caveat as the live path: deduped, capped at 40, so a
        // missing title means UNKNOWN, never a confirmed absence.
        nextRc.featuring_tracks = titles;
        // Keep the classifier's copy in sync — these rows had it empty, which is why
        // a re-scrape was needed at all. A later re-classify pass can now use it.
        nextRc.classifier_track_titles = titles;
      }
      const { error } = await supabase
        .from("playlist_targets")
        .update({ research_context: nextRc })
        .eq("playlist_id", r.playlist_id);
      if (error) {
        console.error("[playlist-research] backfill update", r.playlist_id, error.message);
        return null;
      }
      if (titles.length) ok++;
      return null;
    },
    () => Date.now() > deadline,
  );

  return { featuring_backfill_considered: considered, featuring_backfill_ok: ok };
}

/** Count of web-discovered playlists already in this lane — used as a rotation seed
 * so each run that adds rows shifts the discovery query window forward. */
async function countLaneDiscovered(supabase: SupabaseClient, lane: string): Promise<number> {
  if (!lane) return 0;
  try {
    const { count, error } = await supabase
      .from("playlist_targets")
      .select("playlist_id", { count: "exact", head: true })
      .eq("research_context->>discovery_lane", lane);
    if (error) {
      console.error("[playlist-research] countLaneDiscovered:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.error("[playlist-research] countLaneDiscovered failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Count of rows already ingested by the mass sweep — used as the sweep's rotation
 * seed (the sweep runs lane="", so countLaneDiscovered returns 0 and same-day re-runs
 * would otherwise recycle the identical query set). As the library grows, the window
 * advances and each run surfaces fresh curators. */
async function countSweepDiscovered(supabase: SupabaseClient): Promise<number> {
  try {
    const { count, error } = await supabase
      .from("playlist_targets")
      .select("playlist_id", { count: "exact", head: true })
      .eq("research_context->>source", SWEEP_SOURCE);
    if (error) {
      console.error("[playlist-research] countSweepDiscovered:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (e) {
    console.error("[playlist-research] countSweepDiscovered failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** Playlist IDs pitched in the last 90 days (any track) — excluded from discovery. */
async function recentlyPitchedIds(supabase: SupabaseClient): Promise<Set<string>> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  try {
    const { data, error } = await supabase
      .from("pitch_log")
      .select("playlist_id, pitched_at, created_at")
      .or(`pitched_at.gte.${since},created_at.gte.${since}`)
      .limit(5000);
    if (error) {
      console.error("[playlist-research] recentlyPitchedIds:", error.message);
      return new Set();
    }
    return new Set((data ?? []).map((r: { playlist_id: string }) => r.playlist_id).filter(Boolean));
  } catch (e) {
    console.error("[playlist-research] recentlyPitchedIds failed:", e instanceof Error ? e.message : e);
    return new Set();
  }
}

async function filterDiscoveryCandidates(
  items: DiscoveredPlaylist[],
  references: string[],
  quick: boolean,
  deadline: number = Date.now() + SCRAPE_BUDGET_MS,
): Promise<{ items: DiscoveredPlaylist[]; skips: DiscoverySkips }> {
  const skips: DiscoverySkips = {
    disclaim_brand: 0,
    casual_user: 0,
    micro_playlist: 0,
    artist_as_curator: 0,
    spotify_owned: 0,
    high_bot_risk: 0,
  };
  // Phase 1 — cheap synchronous filters (no network). Survivors that still need
  // the casual-user profile check are collected for a single batched scrape pass.
  const provisional: DiscoveredPlaylist[] = [];
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
    provisional.push(pl);
  }

  // Phase 2 — scrape each *distinct* curator profile ONCE, concurrently. Discovery
  // commonly surfaces several playlists from the same owner; the old code re-scraped
  // that owner's profile once per playlist. Dedupe by owner_id + cache so each
  // curator costs a single scrape, run in parallel instead of sequentially.
  const profileCache = new Map<string, SpotifyUserProfile | null>();
  if (!quick) {
    const ownerIds = [...new Set(provisional.map((p) => p.owner_id).filter((x): x is string => Boolean(x)))];
    if (ownerIds.length && Date.now() < deadline) {
      const profiles = await mapPool(
        ownerIds,
        SCRAPE_CONCURRENCY,
        async (oid) => {
          try {
            return await scrapeSpotifyUserProfile(oid);
          } catch (e) {
            console.error("[discover] profile scrape failed:", oid, e instanceof Error ? e.message : e);
            return null;
          }
        },
        () => Date.now() > deadline,
      );
      ownerIds.forEach((oid, i) => profileCache.set(oid, profiles[i] ?? null));
    }
  }

  // Phase 3 — apply the casual-user verdict, then de-bot score + feel-classify
  // every survivor. bot_risk is always computed and carried forward (persisted to
  // research_context); rows at/above BOT_RISK_THRESHOLD are excluded by default.
  const kept: DiscoveredPlaylist[] = [];
  for (const pl of provisional) {
    const profile = pl.owner_id ? profileCache.get(pl.owner_id) : undefined;
    if (profile) {
      const fc = profile.follower_count;
      const fg = profile.following_count;
      if (fc != null && fg != null && fc < 1000 && fc < fg) {
        console.log("[discover] casual-user skip:", pl.playlist_id, pl.owner, fc, "<", fg);
        skips.casual_user++;
        continue;
      }
    }

    // Score de-bot risk ONLY on real data. For un-enriched rows computeBotRisk
    // returns null ("pending") instead of firing missing_identity/empty_description
    // on fields that are merely absent — that false ~35 poisoned the threshold.
    const { bot_risk, reasons } = computeBotRisk({
      playlist_id: pl.playlist_id,
      name: pl.name,
      description: pl.description,
      owner: pl.owner,
      owner_id: pl.owner_id,
      followers: pl.followers,
      track_count: pl.track_count,
      enriched: pl.enriched,
    });
    pl.bot_risk = bot_risk;
    // Feel is classified from real name + description, so only commit a category
    // for enriched rows; pending rows stay uncategorized until a later run enriches
    // them (then this reclassifies from the real metadata).
    if (pl.enriched !== false) {
      // Classify from every signal: name + description + track artists + track
      // titles. Genre/subgenre + artist cues let rap/house playlists that name no
      // mood still get a sensible bucket (or a neutral rap_general/house_general)
      // instead of whiffing to uncategorized or a wrong mood.
      const feel = classifyFeel(pl.name, pl.description, pl._track_artists ?? [], pl._track_titles ?? []);
      pl.category = feel.category;
      pl.category_confidence = feel.confidence;
      pl.category_reason = feel.reason;
      pl.category_genre = feel.genre;
    } else {
      pl.category = "uncategorized";
      pl.category_confidence = 0;
      pl.category_reason = "enrichment pending";
      pl.category_genre = null;
    }

    // Only enriched rows can be excluded as high-risk; a pending (null) score never
    // clears the threshold, so un-enriched rows are kept and persisted for retry.
    if (bot_risk != null && bot_risk >= BOT_RISK_THRESHOLD) {
      console.log("[discover] high-bot-risk skip:", pl.playlist_id, pl.name, bot_risk, reasons.join(","));
      skips.high_bot_risk++;
      continue;
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
  source = "spotify_web",
  runStartIso?: string,
): Promise<{ newIds: string[]; insertedIds: string[]; upsertErrors: number }> {
  const isSweep = source === SWEEP_SOURCE;
  // Net-new detection: which of these playlist_ids are not already rows? Computed
  // before the upserts (which would otherwise make every id look pre-existing). This
  // is a CANDIDATE count — reconciled against actual inserts below so the reported
  // "new this run" can never drift from the rows that truly landed (root-cause fix
  // for the 7-reported-vs-4-created gap).
  const ids = items.map((p) => p.playlist_id);
  const existingSet = new Set<string>();
  if (ids.length) {
    const { data: existing } = await supabase
      .from("playlist_targets")
      .select("playlist_id")
      .in("playlist_id", ids);
    for (const r of existing ?? []) existingSet.add((r as { playlist_id: string }).playlist_id);
  }
  const newIds = ids.filter((id) => !existingSet.has(id));
  let upsertErrors = 0;

  // Per-row upsert (preserves the conditional-lane semantics — a batch upsert
  // would null out `lane` on re-discovered rows), but run concurrently.
  await mapPool(items, SCRAPE_CONCURRENCY, async (pl) => {
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
    // Sweep rows carry no run-lane (the sweep is genre-seeded, lane=""), so derive a
    // working rap/house lane from the classifier's genre. This is what makes rap a
    // real, countable lane instead of leaving every sweep row lane=NULL. Only stamp
    // for genuinely-classified (enriched) rows — a pending stub has no genre yet.
    const sweepLane = isSweep && pl.enriched === true
      ? laneForSweep((pl.category ?? "uncategorized") as Parameters<typeof laneForSweep>[0], pl.category_genre ?? null)
      : null;
    const rowLane = (tagLane && lane) ? lane : sweepLane;
    // Fraud verdict must reflect what we actually EVALUATED — an unenriched stub has
    // no metadata, so "safe" would read a never-inspected row as cleared (Fendi's bug:
    // fraud_verdict='safe' + fraud_score=null on stubs). Derive both honestly:
    //   • enriched → 'safe' (high-bot-risk rows are already dropped upstream, so an
    //     enriched row that reaches here passed the de-bot gate) with a REAL legitimacy
    //     score of 100 − bot_risk (higher = more legit, matching the ranking that reads
    //     fraud_score higher-is-better); falls back to the neutral 50 only if bot_risk
    //     is somehow absent.
    //   • pending stub → 'pending' + null score, so it can never read as cleared and is
    //     excluded from the `fraud_verdict='safe'` recommend/merge filter until enriched.
    // (fraud_verdict is an unconstrained text column, so 'pending' is a safe new value.)
    const isEnriched = pl.enriched === true;
    const legitScore = typeof pl.bot_risk === "number"
      ? Math.max(0, Math.min(100, 100 - pl.bot_risk))
      : 50;
    const row = {
      playlist_id: pl.playlist_id,
      platform: "spotify",
      playlist_name: pl.name,
      curator_name: pl.owner,
      // Leave NULL when unknown — never default to 0. A 0 here reads as a real
      // "zero followers/tracks" signal and would (a) mislead ranking and (b) let
      // the bot scorer fire follower/track-ratio flags on data we never obtained.
      // The embed page carries no follower count, so this is null for most rows.
      follower_count: pl.followers,
      track_count: pl.track_count,
      overlap_score: 0,
      fraud_score: isEnriched ? legitScore : null,
      fraud_verdict: isEnriched ? "safe" : "pending",
      pitch_status: "not_pitched",
      research_context: {
        source,
        fetched_at: new Date().toISOString(),
        spotify_owner_id: pl.owner_id ?? null,
        discovery_lane: lane || null,
        references: references.slice(0, 8),
        // Enrichment state drives idempotent retry: `enriched:false` rows are
        // picked up by loadUnenrichedSweepRows on a later run. Stored as the string
        // the ->> JSON operator compares against.
        enriched: pl.enriched === true,
        // De-bot + feel signals — persisted, never silently dropped. bot_risk is
        // null while enrichment is pending (a real value only once we have data).
        bot_risk: pl.bot_risk ?? null,
        bot_risk_pending: pl.bot_risk == null,
        category: pl.category ?? "uncategorized",
        category_confidence: pl.category_confidence ?? 0,
        category_reason: pl.category_reason ?? null,
        // Coarse rap/house genre + the derived sweep lane — persisted so the lane is
        // auditable and the re-classify pass can re-derive it without re-scraping.
        category_genre: pl.category_genre ?? null,
        // Classifier version stamp — only for rows actually classified (enriched).
        // Pending rows carry null so the re-classify pass recognizes them as needing
        // classification once enriched. Stale (< CLASSIFIER_VERSION) or null on an
        // enriched row is what triggers the idempotent re-classify pass next run.
        classifier_version: pl.enriched === true ? CLASSIFIER_VERSION : null,
        // Persist the classifier INPUTS so a later re-classify pass can re-run the
        // current classifier without re-scraping. (The embed detail isn't stored
        // anywhere else; without this, re-classification would only have the name.)
        classifier_description: pl.description ?? null,
        classifier_track_artists: pl._track_artists ?? [],
        classifier_track_titles: pl._track_titles ?? [],
        // The SAME scraped titles, under the key the placement/silent-add detector
        // reads (_shared/placement-match.ts → featuringTrackNames, via
        // recommend_targets_for_track). classifier_track_titles feeds the feel
        // classifier; featuring_tracks feeds placement detection. Both are written
        // from one scrape so a sweep row is silent-add detectable the moment it lands
        // — without this bridge the detector saw nothing for every web-scraped target.
        //
        // Omitted (rather than written as []) when the scrape produced no titles, so a
        // failed scrape doesn't assert "features nothing". NOTE: this object REPLACES
        // research_context wholesale on upsert, so omission is not preservation — if a
        // sweep ever re-touches a playlist_id that placement discovery had enriched,
        // that row's real featuring_tracks are lost either way. Pre-existing behaviour
        // for every rc key here, not specific to this one; fixing it needs a
        // read-merge-write like the SFA importer's (see spotify-for-artists-csv.ts).
        //
        // PARTIAL COVERAGE — the embed trackList is a preview, deduped and capped at
        // 40 (see SpotifyPlaylistDetail.track_titles). A track missing from this list
        // is UNKNOWN, not a confirmed absence, so this bridge can only ever prove
        // placements, never disprove them.
        ...(pl._track_titles?.length ? { featuring_tracks: pl._track_titles } : {}),
        // Terminal enrichment verdict — "dead" rows are excluded from future
        // back-fill retries (see loadUnenrichedSweepRows). Null unless proven dead.
        enrich_status: pl.enrich_status ?? null,
      },
      tier: 2,
      whitelist_status: false,
      vibe_tags,
      similar_artists: references.slice(0, 8),
      submission_method: "email",
      submission_url: `https://open.spotify.com/playlist/${pl.id}`,
      is_active: true,
      ...(rowLane ? { lane: rowLane } : {}),
    };
    const { error } = await supabase.from("playlist_targets").upsert(row, {
      onConflict: "playlist_id",
    });
    if (error) {
      upsertErrors++;
      console.error("upsert live", pl.playlist_id, error.message);
    }
    return null;
  });

  // Reconcile the candidate `newIds` against what actually landed: re-read created_at
  // for the candidates and keep only rows whose row was created during THIS run. A
  // candidate that failed to upsert (error) or silently resolved to an UPDATE of a
  // pre-existing row never gets a this-run created_at, so it's correctly excluded.
  // Without a run start we fall back to the candidate list (legacy callers).
  let insertedIds = newIds;
  if (runStartIso && newIds.length) {
    const { data: created } = await supabase
      .from("playlist_targets")
      .select("playlist_id, created_at")
      .in("playlist_id", newIds);
    const landed = new Set(
      (created ?? [])
        .filter((r) => {
          const ts = (r as { created_at?: string | null }).created_at;
          return typeof ts === "string" && ts >= runStartIso;
        })
        .map((r) => (r as { playlist_id: string }).playlist_id),
    );
    insertedIds = newIds.filter((id) => landed.has(id));
  }

  return { newIds, insertedIds, upsertErrors };
}

export async function mergeCatalogAndLive(
  supabase: SupabaseClient,
  trackName: string,
  userVibe: string,
  opts?: { lane?: string; references?: string[]; quick?: boolean; sweep?: boolean; limit?: number },
): Promise<{ results: PlaylistRow[]; live_count: number; new_count: number; discovery_skips: DiscoverySkips; funnel: SweepFunnel }> {
  const lane = (opts?.lane ?? "").trim();
  const references = opts?.references ?? [];
  const sweep = Boolean(opts?.sweep);
  // Per-CALL recommendation cap. Defaults to MAX_RESULTS but is caller-overridable so
  // nothing freezes the per-song return at 20 — the "20/song/day" target is a PER-SONG
  // maximum with NO aggregate ceiling, and N (songs pitched/day) grows over time. Each
  // song's research call is independent; this cap never sums across songs. Clamped to a
  // sane page size.
  const resultLimit = Number.isFinite(opts?.limit) && (opts?.limit ?? 0) > 0
    ? Math.min(200, Math.floor(opts!.limit as number))
    : MAX_RESULTS;

  const start = Date.now();
  // Two staged deadlines carved from one budget. The SEARCH phase stops at
  // `searchDeadline` so it can't consume the whole window; ENRICHMENT + candidate
  // filtering then run until `scrapeDeadline`. This reservation is the fix for
  // rows landing un-enriched — previously a wide sweep's search ate the entire
  // budget and the detail scrape never ran. Both finish before the ~55s edge wall,
  // leaving headroom for the DB upserts/merge/patches below.
  const scrapeDeadline = start + SCRAPE_BUDGET_MS;
  const searchDeadline = start + Math.floor(SCRAPE_BUDGET_MS * SEARCH_BUDGET_FRACTION);
  const quick = Boolean(opts?.quick);

  // Independent prep — fan out the lanes config, the 90-day exclusion set, and the
  // per-lane discovered count (rotation seed) instead of awaiting them in series.
  // The old `findPlaylistOpportunities(...)` pre-query here was discarded entirely
  // (its results are recomputed by the merge query below), so it's dropped.
  const [lanesConfig, excludeIds, laneDiscoveredCount, sweepDiscoveredCount] = await Promise.all([
    loadLanesConfig(supabase),
    recentlyPitchedIds(supabase),
    countLaneDiscovered(supabase, lane),
    sweep ? countSweepDiscovered(supabase) : Promise.resolve(0),
  ]);
  const laneRe = lane ? laneRegexBoost(lanesConfig, lane) : null;
  const pitchAngle = lane ? (lanesConfig[lane]?.pitch_angle ?? "") : "";
  const runStartIso = new Date(start).toISOString();

  // Rotation advances with how many playlists this lane/sweep has already yielded, so
  // a second run the same day shifts the seed window forward and finds fresh curators
  // instead of repeating the (already-deduped) query set. The sweep runs lane="", so
  // it seeds off the total sweep-discovered count rather than a per-lane count.
  const rotation = computeRotation(start, sweep ? sweepDiscoveredCount : laneDiscoveredCount);

  // Mass sweep: replace lane/reference queries with a BALANCED rap+house genre ×
  // modifier set. buildBalancedSweepQueries splits the budget rap-led and interleaves
  // the two genres so every run covers rap AND house (no more house-only drift) and
  // spans many subgenres per run (no more orbiting one). All other machinery —
  // filtering, de-bot scoring, dedupe, upsert — is shared with normal discovery.
  const sweepQueries = sweep
    ? buildBalancedSweepQueries(
      RAP_SUBGENRES,
      HOUSE_SUBGENRES,
      SWEEP_MODIFIERS,
      SWEEP_QUERY_CAP,
      rotation,
    )
    : undefined;

  // SEARCH phase — harvest fresh stubs (bounded by searchDeadline, not the full
  // budget, so enrichment is guaranteed its own window below).
  const { items: freshStubs, funnel: discoveryFunnel } = await discoverViaSpotifyWeb(
    references, lane, quick, excludeIds, searchDeadline, rotation, sweepQueries,
  );

  // Idempotent re-enrichment: a sweep also drains rows an earlier run left pending
  // (`enriched:false`) so they finally get real metadata instead of staying empty
  // stubs. Backlog first (guarantees forward progress), then fresh stubs not already
  // in the backlog; the whole batch is capped so enrichment stays inside budget.
  const reenrich = sweep ? await loadUnenrichedSweepRows(supabase, REENRICH_CAP_SWEEP) : [];
  const detailCap = sweep ? DETAIL_CAP_SWEEP : quick ? DETAIL_CAP_QUICK : DETAIL_CAP_FULL;
  const seenBatch = new Set(reenrich.map((p) => p.playlist_id));
  const batch = [...reenrich];
  for (const s of freshStubs) {
    if (batch.length >= detailCap) break;
    if (seenBatch.has(s.playlist_id)) continue;
    seenBatch.add(s.playlist_id);
    batch.push(s);
  }

  // ENRICHMENT phase — detail scrape fills name/curator/followers/track_count/
  // description before any scoring. Rows the budget never reached stay
  // `enriched:false` and are persisted (below) for the next run to finish.
  const { enriched_ok, enrich_failed, enrich_failed_reasons } = batch.length
    ? await enrichPlaylists(batch, scrapeDeadline)
    : { enriched_ok: 0, enrich_failed: 0, enrich_failed_reasons: {} as Record<string, number> };

  // Back-fill outcome — a subset of the enrichment batch. `reenrich` holds the same
  // object references enrichPlaylists mutated in place, so we can read each stub's
  // result directly. ok = got real metadata; failed = attempted (has a failure
  // reason) but still no name; the rest were never reached before the budget expired
  // and are neither (they persist as stubs and get retried next run).
  // Honest back-fill accounting. `backfilled_ok` counts ONLY rows that recovered a
  // REAL name — the old code reported ok:5 while 5 rows stayed nameless "Playlist
  // 0KLdaP…" stubs. Rows whose embed returned no entity are counted as
  // `backfill_dead` (and marked enrich_status:'dead' so they're never retried), NOT
  // folded into ok. The remainder — attempted, no name, but not proven dead (a
  // transient no_name/exception) — are `backfill_failed` and retried next run.
  const backfilled_ok = reenrich.filter((p) => p.enriched === true).length;
  const backfill_dead = reenrich.filter((p) => p.enrich_status === "dead").length;
  const backfill_failed = reenrich.filter(
    (p) => p.enriched !== true && p.enrich_status !== "dead" && p._enrich_reason,
  ).length;

  const discovery_skips: DiscoverySkips = {
    disclaim_brand: 0,
    casual_user: 0,
    micro_playlist: 0,
    artist_as_curator: 0,
    spotify_owned: 0,
    high_bot_risk: 0,
  };
  let live: DiscoveredPlaylist[] = [];
  let newIds: string[] = [];
  let insertedIds: string[] = [];
  let upsertErrors = 0;
  const ingestSource = sweep ? SWEEP_SOURCE : "spotify_web";
  if (batch.length) {
    // Filtering + bot-risk + feel run AFTER enrichment, so they see real metadata
    // (pending rows score null / stay uncategorized rather than accruing false flags).
    const filtered = await filterDiscoveryCandidates(batch, references, quick, scrapeDeadline);
    discovery_skips.disclaim_brand = filtered.skips.disclaim_brand;
    discovery_skips.casual_user = filtered.skips.casual_user;
    discovery_skips.micro_playlist = filtered.skips.micro_playlist;
    discovery_skips.artist_as_curator = filtered.skips.artist_as_curator;
    discovery_skips.spotify_owned = filtered.skips.spotify_owned;
    discovery_skips.high_bot_risk = filtered.skips.high_bot_risk;
    live = filtered.items;
    if (live.length) {
      const r = await upsertLiveResults(
        supabase, live, lane, references, laneRe, ingestSource, runStartIso,
      );
      newIds = r.newIds;
      insertedIds = r.insertedIds;
      upsertErrors += r.upsertErrors;
    }
  }

  // Buffer growth — bank the OVERFLOW fresh stubs discovery surfaced beyond the
  // enrichment batch as `enriched:false` pending rows. Without this the run drops
  // every stub past DETAIL_CAP_SWEEP, capping library growth at enrichment
  // throughput; banking them lets the sweep find FAR more than a day's sends and
  // drains the backlog on later runs (loadUnenrichedSweepRows). Quality gates are
  // unaffected — these rows are scored/filtered when they enrich, not now.
  let stubs_persisted = 0;
  if (sweep) {
    const overflow = freshStubs
      .filter((s) => !seenBatch.has(s.playlist_id)) // not in the enrichment batch
      .slice(0, PERSIST_STUB_CAP);
    if (overflow.length) {
      const r = await upsertLiveResults(
        supabase, overflow, lane, references, laneRe, ingestSource, runStartIso,
      );
      stubs_persisted = r.insertedIds.length;
      insertedIds = insertedIds.concat(r.insertedIds);
      upsertErrors += r.upsertErrors;
    }
  }
  // Root-cause-#1 — re-classify already-enriched sweep rows still on an older
  // classifier_version (or never stamped). DB-only and idempotent, so it runs even
  // when discovery found nothing. Given a slice of budget AFTER scraping (scraping is
  // done); leftovers catch up next run. This is what corrects the stale `reason=None`
  // mislabels ("Hip Hop: Essentials" → rap_general, "RAP MUSIC 2026" → hype, …).
  const reclassifyDeadline = start + SCRAPE_BUDGET_MS + 6_000;
  const { reclassified_count, reclassified_ok } = sweep
    ? await reclassifySweepRows(supabase, RECLASSIFY_CAP_SWEEP, reclassifyDeadline)
    : { reclassified_count: 0, reclassified_ok: 0 };

  // Back-fill featuring_tracks onto already-enriched rows swept before track titles
  // were captured — a re-scrape (their stored titles are empty), so it gets its own
  // slice of budget AFTER the DB-only re-classify pass. Bounded by
  // BACKFILL_FEATURING_CAP_SWEEP and this deadline; each row is attempted once, so the
  // ~213-row backlog drains across runs. Still inside the 150s edge ceiling.
  const featuringBackfillDeadline = reclassifyDeadline + 25_000;
  const { featuring_backfill_considered, featuring_backfill_ok } = sweep
    ? await backfillFeaturingTracks(supabase, BACKFILL_FEATURING_CAP_SWEEP, featuringBackfillDeadline)
    : { featuring_backfill_considered: 0, featuring_backfill_ok: 0 };

  // `new_this_run` flags rows that TRULY landed this run (created_at reconciled),
  // not the optimistic pre-write candidate set — the fix for reporting 7 when 4
  // were created. `newIds` (candidates) is kept only for the error delta below.
  const newIdSet = new Set(insertedIds);
  const funnel: SweepFunnel = {
    ...discoveryFunnel,
    enriched_ok,
    enrich_failed,
    enrich_failed_reasons,
    backfill_considered: reenrich.length,
    backfilled_ok,
    backfill_failed,
    backfill_dead,
    reclassified_count,
    reclassified_ok,
    featuring_backfill_considered,
    featuring_backfill_ok,
    new_created: insertedIds.length,
    upsert_errors: upsertErrors,
    stubs_persisted,
  };
  console.log(
    `[playlist-research] web discovery: ${freshStubs.length} found, ${reenrich.length} re-enrich, ` +
      `${live.length} ingested, ${newIds.length} new-candidates → ${insertedIds.length} created ` +
      `(${upsertErrors} upsert errors), funnel:`,
    JSON.stringify(funnel),
    "skips:", JSON.stringify(discovery_skips),
    `${Date.now() - start}ms`,
  );

  const vibeTokens = tokenizeVibe(userVibe);
  const trackTokens = tokenizeVibe(trackName);

  // Independent reads — run concurrently.
  const [{ data: mergedRows }, { data: cooling }] = await Promise.all([
    supabase
      .from("playlist_targets")
      .select(
        "playlist_id, platform, playlist_name, curator_name, follower_count, track_count, overlap_score, fraud_score, fraud_verdict, pitch_status, research_context, tier, whitelist_status, vibe_tags, similar_artists, submission_method, submission_url, curator_email, is_active, created_at",
      )
      .eq("is_active", true)
      .in("tier", [1, 2])
      .eq("fraud_verdict", "safe"),
    supabase
      .from("pitch_log")
      .select("playlist_id")
      .eq("track_name", trackName)
      .gt("cooldown_until", new Date().toISOString()),
  ]);

  const excluded = new Set((cooling ?? []).map((r: { playlist_id: string }) => r.playlist_id));
  const merged = (mergedRows ?? [])
    .filter((r: { playlist_id: string }) => !excluded.has(r.playlist_id))
    .map((r: PlaylistRow & { research_context?: Record<string, unknown> | null; created_at?: string | null }) => {
      const rc = r.research_context as Record<string, unknown> | null;
      const source = isWebDiscovered(rc) ? "live" : "catalog";
      const laneScore = scoreLaneBoost(r, laneRe, references);
      const matchesLane = rowMatchesLane(r, lane, laneRe, references);
      const why_it_fits = matchesLane
        ? sanitizeWhyItFits(buildWhyItFits(r, lane, references, laneRe))
        : null;
      // Deprioritize playlists pitched in the last 90 days so the returned set is
      // led by NEW curators instead of recycling the exhausted (already-pitched)
      // ones — they still appear lower down if there aren't enough fresh results.
      const pitchedPenalty = excludeIds.has(r.playlist_id) ? RECENTLY_PITCHED_PENALTY : 0;
      return {
        ...r,
        match_score: scoreRow(r, vibeTokens, trackTokens, laneScore, pitchedPenalty),
        source: source as "catalog" | "live",
        lane: matchesLane ? lane : ((r as { lane?: string }).lane ?? null),
        why_it_fits,
        // Freshness signals surfaced to the admin UI: brand-new this run + when it
        // was first discovered (created_at is set on insert and never overwritten).
        new_this_run: newIdSet.has(r.playlist_id),
        discovered_at: r.created_at ?? null,
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

  const results = merged.slice(0, resultLimit);
  // Lane patches are independent per-row writes — run them concurrently.
  await mapPool(results, SCRAPE_CONCURRENCY, async (r) => {
    const patch: Record<string, unknown> = {};
    const matchesLane = rowMatchesLane(r, lane, laneRe, references);
    if (matchesLane) {
      patch.lane = lane;
      const why = (r as { why_it_fits?: string | null }).why_it_fits;
      if (why) patch.why_it_fits = why;
      const angle = (r as { recommended_pitch_angle?: string | null }).recommended_pitch_angle;
      if (angle) patch.recommended_pitch_angle = angle;
    }
    if (Object.keys(patch).length === 0) return null;
    const { error } = await supabase.from("playlist_targets").update(patch).eq("playlist_id", r.playlist_id);
    if (error) console.error("lane patch", r.playlist_id, error.message);
    return null;
  });

  return {
    results,
    live_count: live.length,
    // Honest: rows that truly landed this run (created_at reconciled), incl. banked
    // overflow stubs — never the optimistic pre-write candidate count.
    new_count: insertedIds.length,
    discovery_skips,
    funnel,
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
    // Mass rap + house sweep. Accepts `sweep: true` or `mode: "mass_sweep_rap_house"`.
    const sweep = Boolean(body.sweep) || String(body.mode ?? "") === SWEEP_SOURCE;

    // track_name drives catalog ranking; the sweep is genre-seeded and doesn't need
    // one, so default it to the sweep label rather than 400-ing.
    if (!track_name && !sweep) {
      return json({ error: "track_name required" }, 400);
    }
    const effectiveTrack = track_name || (sweep ? "mass sweep rap house" : "");

    const quick = Boolean(body.quick);
    // Optional per-song recommendation cap. Omit → MAX_RESULTS. Never an aggregate cap:
    // each song calls this independently and gets its own `limit` targets.
    const limit = Number(body.limit) || undefined;
    const { results, live_count, new_count, discovery_skips, funnel } = await mergeCatalogAndLive(supabase, effectiveTrack, user_vibe, {
      lane,
      references,
      quick,
      sweep,
      limit,
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
      track_name: effectiveTrack,
      sweep,
      source: sweep ? SWEEP_SOURCE : "spotify_web",
      user_vibe: user_vibe,
      lane: lane || null,
      references,
      count: results.length,
      live_api_ingested: live_count,
      new_this_run: new_count,
      discovery_skips,
      // Full discovery→enrichment funnel, surfaced so a zero/empty run is
      // diagnosable from the response body alone (no log access needed).
      funnel,
      quick,
      playlists,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return json({ error: true, message: msg }, 500);
  }
});
