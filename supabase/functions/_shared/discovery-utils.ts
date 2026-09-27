/**
 * discovery-utils — pure, testable helpers for playlist-research discovery.
 *
 * Extracted from playlist-research/index.ts so the timing/dedup logic can be
 * unit-tested without booting the edge function (its module body calls
 * Deno.serve at import time).
 */

/**
 * Run `fn` over `items` with a bounded number of in-flight tasks, preserving
 * input order in the output array. This replaces the old sequential
 * `for…await…sleep` loops: independent Firecrawl scrapes have no ordering
 * dependency, so we fan them out `concurrency`-at-a-time instead of one-by-one.
 *
 * `shouldStop` is polled before each task is launched; once it returns true we
 * stop launching new work and leave the remaining slots `undefined` (the
 * deadline guard — a slow run returns what it has rather than blowing the wall).
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, items.length));
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (shouldStop()) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

// Modifier templates appended to the lane label. Rotated per-run so successive
// discoveries probe different facets of Spotify search instead of the same 2 queries.
// Folds back the broader terms orphaned when discovery-seeds.ts was reduced to a
// re-export ("2026", "submit", "discover", "deep cuts", "rotation", "monthly",
// "selects", "favourites") so the modifier surface is as wide as it was pre-dedupe.
export const LANE_MODIFIERS = [
  "playlist", "curator", "best", "fresh", "new", "2025", "2026", "weekly", "underground",
  "indie", "submissions", "submit", "mix", "radio", "vibes", "essentials", "rising",
  "hidden gems", "playlist 2024", "spotify playlist", "top", "chill", "discover",
  "deep cuts", "rotation", "monthly", "selects", "favourites",
];
// Templates applied to each reference artist (e.g. "<artist> type playlist").
export const REF_MODIFIERS = [
  "type playlist", "radio", "mix", "similar artists playlist", "essentials",
  "fans playlist", "inspired playlist", "fans also like", "adjacent",
];

// ---------------------------------------------------------------------------
// Mass rap + house sweep seeds
// ---------------------------------------------------------------------------
// Plain arrays × modifiers so the net is trivially extensible: add a subgenre or
// a modifier and the cross-product widens. Kept genre-only (no artist refs) so a
// sweep spans the whole space instead of orbiting one lane's reference set.

/** Rap/house search-term fixtures for unit tests only.
 * Operational discovery loads included_search_terms from discovery_profiles. */
export const TEST_FIXTURE_RAP_SUBGENRES = [
  "trap", "drill", "boom bap", "melodic rap", "rage rap", "west coast rap",
  "east coast rap", "southern hip hop", "underground hip hop", "lofi rap",
  "conscious rap", "hard rap", "club rap", "party rap", "gangsta rap", "g-funk",
  "phonk", "plugg", "hip hop", "rap", "new rap", "hip hop 2026",
];

export const TEST_FIXTURE_HOUSE_SUBGENRES = [
  "deep house", "tech house", "afro house", "soulful house", "bass house",
  "progressive house", "melodic house", "organic house", "disco house",
  "funky house", "vocal house", "amapiano", "house",
];

/** Curator/freshness modifiers for the genre sweep (distinct from lane modifiers,
 * tuned to surface human-curated, pitchable, current playlists).
 *
 * The last block is SOURCE-oriented: terms that reliably return third-party
 * listicle / directory / roundup PAGES ("best … playlists 2026", blog round-ups,
 * submission directories). Those pages embed dozens of open.spotify.com/playlist
 * links — which the hit-page harvest (see selectHarvestUrls + harvestPlaylistIds
 * in playlist-research) scrapes in full. Breadth of SOURCE, not just count of
 * queries, is what breaks the dedupe-to-nothing collapse: one directory page can
 * yield 30-50 distinct playlists where a bare genre search yields ~1. */
export const SWEEP_MODIFIERS = [
  "playlist", "curator", "submissions", "submit", "best", "fresh", "new",
  "2025", "2026", "weekly", "monthly", "underground", "indie", "rising",
  "hidden gems", "top", "mix", "essentials", "rotation", "fresh finds",
  "new music", "spotify playlist", "picks", "on repeat", "roundup", "heat",
  "submissions open",
  // Source-oriented (listicle / directory / roundup pages, harvested in full):
  "best playlists 2026", "playlist roundup", "playlists to submit to",
  "curator list", "independent playlists", "playlist directory",
];

/**
 * Build the genre × modifier query set for a mass sweep. Rotates both the
 * subgenre order and the modifier order by `rotation` so successive runs probe
 * different facets instead of recycling the same queries, then dedupes and caps.
 */
export function buildSweepQueries(
  subgenres: string[],
  modifiers: string[],
  cap: number,
  rotation: number,
): string[] {
  const rotate = <T,>(arr: T[]): T[] =>
    arr.length
      ? [...arr.slice(rotation % arr.length), ...arr.slice(0, rotation % arr.length)]
      : arr;

  const out: string[] = [];
  for (const g of rotate(subgenres)) {
    for (const m of rotate(modifiers)) out.push(`${g} ${m}`);
  }
  return [...new Set(out)].slice(0, cap);
}

/**
 * Build a BALANCED, breadth-first sweep query set.
 *
 * The old `buildSweepQueries` emitted the cross-product subgenre-outer
 * (`for g: for m`) then sliced to `cap`. With ~19 modifiers a `cap` of 24 only
 * reached ~1.3 subgenres per run, so a single sweep orbited one or two subgenres —
 * and because the array is subgenre-ordered, whichever region the daily rotation
 * landed in (house or rap) is ALL a run probed. That is exactly why recent runs
 * drifted house-heavy and the rap lane went stale (root cause of Problem 2), and
 * why so many results died at dedupe (the query set kept hitting the same ground —
 * Problem 1).
 *
 * This builder fixes both:
 *   1. **Modifier-outer, subgenre-inner** (`for m: for g`) so the first pass alone
 *      probes EVERY subgenre before any modifier repeats — maximal genre spread
 *      inside the cap instead of 1-2 subgenres.
 *   2. **Explicit rap/house budget split** (`rapShare`, default rap-led 0.55) built
 *      independently and then INTERLEAVED, so every run guarantees rap AND house
 *      coverage — the sweep can no longer collapse into one genre.
 *
 * Both the subgenre order and modifier order rotate by `rotation` so successive
 * runs surface different facets rather than recycling the (already-deduped) set.
 */
export function buildBalancedSweepQueries(
  rapSubgenres: string[],
  houseSubgenres: string[],
  modifiers: string[],
  cap: number,
  rotation: number,
  rapShare = 0.55,
): string[] {
  const rotate = <T,>(arr: T[]): T[] =>
    arr.length
      ? [...arr.slice(rotation % arr.length), ...arr.slice(0, rotation % arr.length)]
      : arr;

  const buildSide = (subs: string[], budget: number): string[] => {
    const rs = rotate(subs);
    const rm = rotate(modifiers);
    const side: string[] = [];
    // Modifier-outer / subgenre-inner: one full modifier pass covers all subgenres.
    for (const m of rm) {
      for (const g of rs) {
        if (side.length >= budget) return side;
        side.push(`${g} ${m}`);
      }
    }
    return side;
  };

  const rapBudget = Math.max(1, Math.round(cap * rapShare));
  const houseBudget = Math.max(1, cap - rapBudget);
  const rapQ = buildSide(rapSubgenres, rapBudget);
  const houseQ = buildSide(houseSubgenres, houseBudget);

  // Interleave so a truncated run still carries both genres, not a rap-only prefix.
  const merged: string[] = [];
  const n = Math.max(rapQ.length, houseQ.length);
  for (let i = 0; i < n; i++) {
    if (i < rapQ.length) merged.push(rapQ[i]);
    if (i < houseQ.length) merged.push(houseQ[i]);
  }
  return [...new Set(merged)].slice(0, cap);
}

/**
 * Per-run rotation index. Daily rotation alone repeats every query for re-runs
 * on the same day; we add the count of playlists already discovered for this
 * lane so each successful run shifts the seed window forward and surfaces fresh
 * curators instead of recycling the exhausted set.
 */
export function computeRotation(nowMs: number, laneDiscoveredCount: number): number {
  const day = Math.floor(nowMs / 86_400_000);
  return day + laneDiscoveredCount;
}

/**
 * Build a broad, varied query set. Combines the lane label with many
 * genre/keyword modifiers and each reference artist with several templates,
 * then rotates the modifier order by `rotation` so re-runs surface different
 * playlists.
 */
export function buildDiscoveryQueries(
  references: string[],
  lane: string,
  cap: number,
  rotation: number,
): string[] {
  const laneLabel = lane ? lane.replace(/_/g, " ") : "";
  const rotate = <T,>(arr: T[]): T[] =>
    arr.length
      ? [...arr.slice(rotation % arr.length), ...arr.slice(0, rotation % arr.length)]
      : arr;

  const out: string[] = [];
  if (laneLabel) {
    for (const m of rotate(LANE_MODIFIERS)) out.push(`${laneLabel} ${m}`);
  }
  const refs = references.map((r) => r.split(/[—–-]/)[0].trim()).filter(Boolean);
  for (const ref of refs) {
    for (const m of rotate(REF_MODIFIERS)) out.push(`${ref} ${m}`);
  }
  return [...new Set(out)].slice(0, cap);
}

/** Matches every Spotify playlist URL in a blob of text; capture group is the id. */
const PLAYLIST_URL_RE = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/g;

/**
 * Harvest Spotify playlist ids from arbitrary text (web-search hit urls/titles/
 * descriptions). This is the discovery channel that actually yields playlists for
 * broad genre queries — Spotify's own search page is a client-rendered SPA that
 * returns no crawlable playlist anchors, so scraping it alone finds nothing.
 * Editorial ids (37i9dQZF…) are dropped — algorithmic, nobody to pitch — and the
 * result is deduped in first-seen order.
 */
export function extractPlaylistIdsFromText(blob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(PLAYLIST_URL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null) {
    const id = m[1];
    if (id.startsWith("37i9dQZF")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const SPOTIFY_ID_RE = /^[a-zA-Z0-9]{22}$/;
const SPOTIFY_ENTITY_TYPES = ["playlist", "track", "album", "artist", "show", "episode", "user"];

export type SpotifyPlaylistIdParse =
  | { ok: true; id: string }
  | { ok: false; code: "empty" | "wrong_entity_type" | "malformed" | "editorial"; entity?: string };

/**
 * Parse ONE supported Spotify playlist reference into its canonical 22-char id.
 * Supported: bare id, spotify:ID (this codebase's stored-key form), spotify:playlist:ID,
 * spotify:user:<u>:playlist:ID, and open.spotify.com[/intl-xx][/embed]/playlist/ID URLs.
 * Other entity types (track/album/artist/…) fail with wrong_entity_type — prefixes are
 * never stripped blindly. Editorial algorithmic playlists (37i9dQZF…) fail: nobody to pitch.
 */
export function parseSpotifyPlaylistId(raw: string | null | undefined): SpotifyPlaylistIdParse {
  const v = String(raw ?? "").trim();
  if (!v) return { ok: false, code: "empty" };
  let id: string | null = null;

  if (/^https?:\/\//i.test(v) || /^open\.spotify\.com\//i.test(v)) {
    let path: string;
    try {
      const u = new URL(/^https?:/i.test(v) ? v : `https://${v}`);
      if (!/(^|\.)spotify\.com$/i.test(u.hostname)) return { ok: false, code: "malformed" };
      path = u.pathname;
    } catch {
      return { ok: false, code: "malformed" };
    }
    const segs = path.split("/").filter(Boolean).filter((s) => !/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(s) && s !== "embed");
    const typeIdx = segs.findIndex((s) => SPOTIFY_ENTITY_TYPES.includes(s.toLowerCase()) && s.toLowerCase() !== "user");
    if (typeIdx < 0) return { ok: false, code: "malformed" };
    const entity = segs[typeIdx].toLowerCase();
    if (entity !== "playlist") return { ok: false, code: "wrong_entity_type", entity };
    id = segs[typeIdx + 1] ?? null;
  } else if (/^spotify:/i.test(v)) {
    const parts = v.split(":");
    if (parts.length === 2) {
      id = parts[1]; // spotify:ID — stored-key form used by pitch_log / placements
    } else {
      const pi = parts.findIndex((p, k) => k > 0 && p.toLowerCase() === "playlist");
      if (pi < 0) {
        const entity = parts[1]?.toLowerCase();
        return entity && SPOTIFY_ENTITY_TYPES.includes(entity)
          ? { ok: false, code: "wrong_entity_type", entity }
          : { ok: false, code: "malformed" };
      }
      id = parts[pi + 1] ?? null;
    }
  } else {
    id = v;
  }

  if (!id || !SPOTIFY_ID_RE.test(id)) return { ok: false, code: "malformed" };
  if (id.startsWith("37i9dQZF")) return { ok: false, code: "editorial" };
  return { ok: true, id };
}

/**
 * Every playlist_targets key under which the same Spotify playlist may already be
 * stored. `spotify:<id>` is a legitimate stored-key convention in this codebase
 * (placements, pitch_log), so lookups must check all forms instead of renaming rows.
 */
export function playlistTargetKeyAliases(canonicalId: string): string[] {
  return [canonicalId, `spotify:${canonicalId}`, `spotify:playlist:${canonicalId}`];
}

/**
 * Normalize a Spotify playlist id and/or URL to a canonical pair before insert.
 * Returns null when unresolvable, the wrong entity type, or editorial.
 */
export function normalizeSpotifyPlaylistIdentity(
  rawId?: string | null,
  rawUrl?: string | null,
): { playlist_id: string; playlist_url: string } | null {
  let id: string | null = null;
  const fromId = parseSpotifyPlaylistId(rawId);
  if (fromId.ok) id = fromId.id;
  else if (!(fromId.code === "wrong_entity_type" || fromId.code === "editorial")) {
    const fromUrl = parseSpotifyPlaylistId(rawUrl);
    if (fromUrl.ok) id = fromUrl.id;
    else if (fromId.code === "empty" || fromId.code === "malformed") {
      // Last resort: a playlist URL embedded in free text.
      const found = extractPlaylistIdsFromText(String(rawUrl ?? "")).concat(
        extractPlaylistIdsFromText(String(rawId ?? "")),
      );
      if (found[0] && fromUrl.code !== "wrong_entity_type" && fromUrl.code !== "editorial") id = found[0];
    }
  }
  if (!id) return null;
  return {
    playlist_id: id,
    playlist_url: `https://open.spotify.com/playlist/${id}`,
  };
}

export type SearchHitLike = { url: string; title?: string; description?: string };

/**
 * Choose which web-search hit PAGES are worth scraping in full to harvest embedded
 * playlist links. This is the fix for the discovery-volume collapse: the bare
 * web-search channel only sees playlist urls that happen to appear in a hit's
 * url/title/description (~1 id per query), but the hit PAGES themselves —
 * "best rap playlists 2026" listicles, curator directories, blog roundups — embed
 * dozens of open.spotify.com/playlist links in their body. Scraping the top few of
 * those pages (harvestPlaylistIds in playlist-research) multiplies distinct-id yield
 * by 10-30× without widening the query set.
 *
 * Selection rules (pure, so the wiring stays trivially testable):
 *   - Skip open.spotify.com hits — playlist/artist pages are client-rendered SPAs
 *     with no crawlable anchors (that's the whole premise of the web-search channel),
 *     and any playlist id in the hit url is already captured by extractPlaylistIdsFromText.
 *   - Skip obvious non-article hosts (youtube/apple/social) that won't carry a list
 *     of Spotify playlist links.
 *   - At most `perHost` pages per host, so one dominant blog can't eat the whole cap.
 *   - Preserve first-seen (search-rank) order and cap the total.
 */
const HARVEST_SKIP_HOSTS = [
  "open.spotify.com", "spotify.com", "youtube.com", "youtu.be", "music.apple.com",
  "apple.com", "instagram.com", "facebook.com", "twitter.com", "x.com", "tiktok.com",
];

export function selectHarvestUrls(
  hits: SearchHitLike[],
  cap: number,
  perHost = 1,
): string[] {
  const out: string[] = [];
  const seenUrl = new Set<string>();
  const hostCount = new Map<string, number>();
  for (const h of hits) {
    if (out.length >= cap) break;
    const url = (h?.url ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seenUrl.has(url)) continue;
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (HARVEST_SKIP_HOSTS.some((skip) => host === skip || host.endsWith(`.${skip}`))) continue;
    const used = hostCount.get(host) ?? 0;
    if (used >= perHost) continue;
    seenUrl.add(url);
    hostCount.set(host, used + 1);
    out.push(url);
  }
  return out;
}

export type StubLike = { playlist_id?: string | null };

/**
 * Dedupe scraped stubs against (a) ids already seen this run and (b) the
 * recently-pitched exclusion set, returning the fresh ids in order plus the
 * count skipped as recently-pitched. `seen` is mutated so it can be threaded
 * across multiple search results. This is the freshness gate for discovery
 * output — it is what guarantees a run surfaces NEW playlists.
 */
export function dedupeStubs(
  stubs: StubLike[],
  seen: Set<string>,
  excludeIds: Set<string>,
): { freshIds: string[]; skippedRecent: number } {
  const freshIds: string[] = [];
  let skippedRecent = 0;
  for (const s of stubs) {
    if (!s.playlist_id) continue;
    const pid = `spotify:${s.playlist_id}`;
    if (seen.has(pid)) continue;
    if (excludeIds.has(pid)) {
      skippedRecent++;
      continue;
    }
    seen.add(pid);
    freshIds.push(pid);
  }
  return { freshIds, skippedRecent };
}
