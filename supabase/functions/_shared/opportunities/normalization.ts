// Opportunity Engine — normalization & dedupe keys.
//
// Deterministic string normalization so the same real-world entity/opportunity
// maps to the same key regardless of casing, whitespace, URL scheme, or handle
// punctuation. Mirrors the proven public.relationships.dedupe_key approach.

/** Lowercase, trim, collapse internal whitespace. Empty -> "". */
export function normalizeText(s?: string | null): string {
  if (!s) return "";
  return s.toString().trim().toLowerCase().replace(/\s+/g, " ");
}

/** Platform to a canonical slug (e.g. "Spotify " -> "spotify"). */
export function normalizePlatform(platform?: string | null): string {
  return normalizeText(platform).replace(/[^a-z0-9]+/g, "");
}

/**
 * External id: strip a leading @, surrounding slashes and whitespace, lowercase.
 * Handles handles ("@Curator"), path ids ("/playlist/37i9..."), and raw ids.
 */
export function normalizeExternalId(externalId?: string | null): string {
  if (!externalId) return "";
  return externalId
    .toString()
    .trim()
    .replace(/^@+/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

/** Normalize a URL for comparison: drop scheme, www, trailing slash, lowercase host+path. */
export function normalizeUrl(url?: string | null): string {
  if (!url) return "";
  let u = url.toString().trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return u;
}

/**
 * Entity dedupe key. Prefers the strong (platform, external_id) identity; falls
 * back to (platform, canonical_url) and finally (entity_type, name) so a manually
 * entered entity without an id is still deduped by name.
 */
export function entityDedupeKey(input: {
  entity_type: string;
  name: string;
  platform?: string | null;
  platform_external_id?: string | null;
  canonical_url?: string | null;
}): string {
  const platform = normalizePlatform(input.platform);
  const extId = normalizeExternalId(input.platform_external_id);
  if (platform && extId) return `${platform}:id:${extId}`;
  const url = normalizeUrl(input.canonical_url);
  if (platform && url) return `${platform}:url:${url}`;
  if (url) return `url:${url}`;
  return `${normalizeText(input.entity_type)}:name:${normalizeText(input.name)}`;
}

/**
 * Opportunity dedupe key. One opportunity per (entity, type, target-of-action),
 * where target-of-action is the recommended song when present, else the source
 * URL, else the entity itself. Prevents the same play being surfaced twice.
 */
export function opportunityDedupeKey(input: {
  entity_id: string;
  opportunity_type: string;
  recommended_song_id?: string | null;
  source_url?: string | null;
}): string {
  const entity = normalizeText(input.entity_id);
  const type = normalizeText(input.opportunity_type);
  const song = normalizeText(input.recommended_song_id);
  if (song) return `${entity}|${type}|song:${song}`;
  const url = normalizeUrl(input.source_url);
  if (url) return `${entity}|${type}|url:${url}`;
  return `${entity}|${type}`;
}
