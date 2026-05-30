/** Discovery-time curator quality filters (playlist-research). */

export function normalizeCuratorName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SPOTIFY_OWNED_CURATOR_NORMS = new Set([
  "spotify",
  "spotifyusa",
  "spotifyuk",
  "spotifycanada",
  "spotifylatam",
  "spotifyfrance",
  "spotifydeutschland",
  "spotifyjapan",
  "spotifykorea",
  "spotifybrasil",
  "spotifyaustralia",
  "spotifyitalia",
  "spotifyespana",
  "filtr",
  "filtrusa",
  "filtrbrasil",
  "topsify",
  "digster",
]);

const ALGORITHMIC_SUFFIXES = [
  / radio$/i,
  / mix$/i,
  /^this is /i,
  / collaborated playlist$/i,
];

/** Spotify editorial / algorithmic — no human curator to pitch. */
export function isSpotifyOwnedCurator(
  curatorName: string | null | undefined,
  playlistName?: string | null,
): boolean {
  const norm = normalizeCuratorName(curatorName);
  if (norm && SPOTIFY_OWNED_CURATOR_NORMS.has(norm)) return true;
  const lower = (curatorName ?? "").toLowerCase().trim();
  if (lower === "spotify" || lower.startsWith("spotify ")) return true;
  if (["filtr", "topsify", "digster"].includes(lower)) return true;
  if (playlistName && ALGORITHMIC_SUFFIXES.some((re) => re.test(playlistName))) return true;
  return false;
}

/** Reference artist surfaced as playlist owner (artist account, not a submissions curator). */
export function isArtistAsCurator(
  curatorName: string | null | undefined,
  references: string[],
): boolean {
  const curatorNorm = normalizeCuratorName(curatorName);
  if (!curatorNorm) return false;
  const refNorms = references.map(normalizeCuratorName).filter((n) => n.length > 1);
  for (const rn of refNorms) {
    if (curatorNorm === rn) return true;
    if (curatorNorm.includes(rn) || rn.includes(curatorNorm)) return true;
  }
  return false;
}
