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
// Templates applied to each reference artist (e.g. "Kaytranada type playlist").
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

/** Rap subgenres — the full spread the sweep should cover. Deliberately broad and
 * rap-led (Fendi's catalogue spans house rap, trap, conscious/hard rap, and club
 * records) so the balanced sweep always has a deep rap bench to interleave from. */
export const RAP_SUBGENRES = [
  "trap", "drill", "boom bap", "melodic rap", "rage rap", "west coast rap",
  "east coast rap", "southern hip hop", "underground hip hop", "lofi rap",
  "conscious rap", "hard rap", "club rap", "party rap", "gangsta rap", "g-funk",
  "phonk", "plugg", "hip hop", "rap", "new rap", "hip hop 2026",
];

/** House subgenres — the full spread the sweep should cover. */
export const HOUSE_SUBGENRES = [
  "deep house", "tech house", "afro house", "soulful house", "bass house",
  "progressive house", "melodic house", "organic house", "disco house",
  "funky house", "vocal house", "amapiano", "house",
];

/** Curator/freshness modifiers for the genre sweep (distinct from lane modifiers,
 * tuned to surface human-curated, pitchable, current playlists). */
export const SWEEP_MODIFIERS = [
  "playlist", "curator", "submissions", "submit", "best", "fresh", "new",
  "2025", "2026", "weekly", "monthly", "underground", "indie", "rising",
  "hidden gems", "top", "mix", "essentials", "rotation", "fresh finds",
  "new music", "spotify playlist", "picks", "on repeat", "roundup", "heat",
  "submissions open",
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
