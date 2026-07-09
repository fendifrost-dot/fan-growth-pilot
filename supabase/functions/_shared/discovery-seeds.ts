/**
 * Pure discovery-seed + dedup helpers for playlist-research.
 *
 * Kept out of playlist-research/index.ts (which calls Deno.serve at module load)
 * so they can be unit-tested in isolation. No network, no Deno globals.
 */
import type { SpotifyPlaylistStub } from "./spotify-scrape.ts";

export type DiscoveredPlaylist = {
  id: string;
  playlist_id: string;
  name: string;
  description?: string;
  followers: number | null;
  owner: string | null;
  owner_id?: string;
  _track_artists?: string[];
};

// Modifier templates appended to the lane label. Rotated per-run so successive
// discoveries probe different facets of Spotify search instead of the same queries.
// Broadened (was 16) so deeper pagination per run surfaces new curators rather
// than recycling the exhausted head of the list.
export const LANE_MODIFIERS = [
  "playlist", "curator", "best", "fresh", "new", "2025", "2026", "weekly",
  "underground", "indie", "submissions", "submit", "mix", "radio", "vibes",
  "essentials", "rising", "hidden gems", "discover", "deep cuts", "rotation",
  "monthly", "selects", "favourites",
];
// Templates applied to each reference artist (e.g. "Kaytranada type playlist").
export const REF_MODIFIERS = [
  "type playlist", "radio", "mix", "similar artists playlist", "essentials",
  "fans also like", "adjacent",
];

/**
 * Build a broad, varied query set. Combines the lane label with many genre/keyword
 * modifiers and each reference artist with several templates, then rotates the
 * modifier order by `rotation` so re-runs surface different playlists. `rotation`
 * is supplied by the caller (a per-run time bucket) — pass distinct values to get
 * distinct query windows.
 */
export function buildDiscoveryQueries(
  references: string[],
  lane: string,
  cap: number,
  rotation: number,
): string[] {
  const laneLabel = lane ? lane.replace(/_/g, " ") : "";
  const rotate = <T,>(arr: T[]): T[] =>
    arr.length ? [...arr.slice(rotation % arr.length), ...arr.slice(0, rotation % arr.length)] : arr;

  const out: string[] = [];
  if (laneLabel) {
    for (const m of rotate(LANE_MODIFIERS)) out.push(`${laneLabel} ${m}`);
  }
  const refs = references.map((r) => r.split(/[—–-]/)[0].trim()).filter(Boolean);
  for (const ref of refs) {
    for (const m of rotate(REF_MODIFIERS)) out.push(`${ref} ${m}`);
  }
  // Interleave lane + ref queries so a low cap still gets a mix of both.
  return [...new Set(out)].slice(0, cap);
}

/**
 * Reduce raw search stubs into fresh, unseen, pitch-deduped DiscoveredPlaylists.
 *
 * Mutates `seen` (cross-query de-dup). `excludeIds` is the 90-day pitch-log set —
 * matching the `spotify:<id>` key format written to pitch_log — so already-pitched
 * playlists are dropped from discovery OUTPUT, not merely counted. Returns the
 * newly-added items plus how many were skipped as recently pitched.
 */
export function collectFreshStubs(
  stubs: SpotifyPlaylistStub[],
  stubsPerRef: number,
  seen: Set<string>,
  excludeIds: Set<string>,
): { added: DiscoveredPlaylist[]; skippedRecent: number } {
  const added: DiscoveredPlaylist[] = [];
  let skippedRecent = 0;
  for (const s of stubs.slice(0, stubsPerRef)) {
    if (!s.playlist_id) continue;
    const pid = `spotify:${s.playlist_id}`;
    if (seen.has(pid)) continue;
    if (excludeIds.has(pid)) {
      skippedRecent++;
      continue;
    }
    seen.add(pid);
    added.push({
      id: s.playlist_id,
      playlist_id: pid,
      name: s.name,
      followers: null,
      owner: s.owner_name ?? null,
      owner_id: s.owner_id,
    });
  }
  return { added, skippedRecent };
}
