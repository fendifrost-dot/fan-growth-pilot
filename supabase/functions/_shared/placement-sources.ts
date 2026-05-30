/** Sources that mean “playlist already features the artist” (warm outreach). */
export const WARM_PLACEMENT_SOURCES = new Set([
  "spotify_placement",
  "spotify_for_artists_csv",
]);

export function isWarmPlacementSource(source: string | null | undefined): boolean {
  return !!source && WARM_PLACEMENT_SOURCES.has(source);
}
