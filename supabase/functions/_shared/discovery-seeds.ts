/**
 * Pure discovery-seed + dedup helpers for playlist-research.
 *
 * Kept out of playlist-research/index.ts (which calls Deno.serve at module load)
 * so they can be unit-tested in isolation. No network, no Deno globals.
 */
import type { SpotifyPlaylistStub } from "./spotify-scrape.ts";

// Query-seed helpers (modifier tables + query builder) have a single canonical
// home in discovery-utils.ts — the module that playlist-research/index.ts imports
// and that discovery-utils.test.ts covers. Re-exported here so seed-related code
// can resolve them from either module without a divergent second copy.
export { buildDiscoveryQueries, LANE_MODIFIERS, REF_MODIFIERS } from "./discovery-utils.ts";

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
