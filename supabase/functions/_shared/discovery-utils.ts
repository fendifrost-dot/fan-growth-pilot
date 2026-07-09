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
export const LANE_MODIFIERS = [
  "playlist", "curator", "best", "fresh", "new", "2025", "weekly", "underground",
  "indie", "submissions", "mix", "radio", "vibes", "essentials", "rising", "hidden gems",
  "playlist 2024", "spotify playlist", "top", "chill",
];
// Templates applied to each reference artist (e.g. "Kaytranada type playlist").
export const REF_MODIFIERS = [
  "type playlist", "radio", "mix", "similar artists playlist", "essentials",
  "fans playlist", "inspired playlist",
];

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
