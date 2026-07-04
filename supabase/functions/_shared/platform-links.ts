// platform-links.ts — "Give one streaming URL, get the others."
//
// The write/generation side of the multi-platform smart link. Given the URLs a
// smart link points to (its destination and whatever DSP URLs already live in
// metadata), resolve the matching link on every other platform and return them
// as the individual `*_url` metadata keys the public landing page renders as
// per-DSP buttons (see src/pages/SmartLinkPage.tsx):
//
//   spotify_url, apple_music_url, soundcloud_url, youtube_url, tidal_url
//
// Reliability: Odesli/song.link is unreliable for brand-new Fendi releases
// (misses platforms for hours-to-days). So this is a HYBRID — the union of:
//   1. Odesli/song.link  → the primary "one link finds the others" engine
//   2. iTunes Search      → independent Apple Music fallback (public, no key)
//   3. Spotify Web API    → independent Spotify fallback (client-credentials)
// No URL is ever guessed: every URL returned came from one of these APIs or was
// the seed URL itself. The seed's own platform is always kept verbatim.

const UA =
  "Mozilla/5.0 (compatible; FendiFrostArtworkBot/1.0; +https://links.fendifrost.com)";

/** The metadata keys the landing page reads to render DSP buttons. */
export const PLATFORM_METADATA_KEYS = [
  "spotify_url",
  "apple_music_url",
  "soundcloud_url",
  "youtube_url",
  "tidal_url",
] as const;

export type PlatformKey = (typeof PLATFORM_METADATA_KEYS)[number];
export type PlatformLinks = Partial<Record<PlatformKey, string>>;

// ── URL detection: which platform metadata key does a raw URL belong to? ──
const SEED_MATCHERS: Array<{ key: PlatformKey; re: RegExp }> = [
  { key: "spotify_url", re: /open\.spotify\.com\//i },
  { key: "apple_music_url", re: /music\.apple\.com\//i },
  { key: "soundcloud_url", re: /soundcloud\.com\//i },
  { key: "youtube_url", re: /(?:music\.)?youtube\.com\/|youtu\.be\//i },
  { key: "tidal_url", re: /tidal\.com\//i },
];

/** Return the platform metadata key a URL belongs to, or null. */
function platformOf(url: string): PlatformKey | null {
  for (const m of SEED_MATCHERS) if (m.re.test(url)) return m.key;
  return null;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── 1. Odesli / song.link ──────────────────────────────────────────────────
// Maps Odesli platform keys → our metadata keys. youtubeMusic preferred over
// youtube; appleMusic preferred over the store-only itunes entry.
const ODESLI_KEY_MAP: Array<{ odesli: string; key: PlatformKey }> = [
  { odesli: "spotify", key: "spotify_url" },
  { odesli: "appleMusic", key: "apple_music_url" },
  { odesli: "itunes", key: "apple_music_url" },
  { odesli: "soundcloud", key: "soundcloud_url" },
  { odesli: "youtubeMusic", key: "youtube_url" },
  { odesli: "youtube", key: "youtube_url" },
  { odesli: "tidal", key: "tidal_url" },
];

interface OdesliResult {
  links: PlatformLinks;
  title?: string;
  artist?: string;
}

async function fromOdesli(seedUrl: string): Promise<OdesliResult | null> {
  const api = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(
    seedUrl,
  )}&userCountry=US`;
  const data = await fetchJson(api);
  if (!data) return null;

  const byPlatform = (data.linksByPlatform ?? {}) as Record<string, { url?: string }>;
  const links: PlatformLinks = {};
  for (const { odesli, key } of ODESLI_KEY_MAP) {
    const url = byPlatform[odesli]?.url;
    // First writer wins (map is ordered by preference), so appleMusic beats
    // itunes and youtubeMusic beats youtube.
    if (url && !links[key]) links[key] = url;
  }

  // Pull title/artist for the iTunes/Spotify supplement queries.
  let title: string | undefined;
  let artist: string | undefined;
  const entities = (data.entitiesByUniqueId ?? {}) as Record<
    string,
    { title?: string; artistName?: string }
  >;
  const primary = data.entityUniqueId ? entities[data.entityUniqueId] : undefined;
  const entity = primary ?? Object.values(entities)[0];
  if (entity) {
    title = entity.title;
    artist = entity.artistName;
  }

  return { links, title, artist };
}

// ── 2. iTunes Search → Apple Music album URL (public, no key) ────────────────
// Strip the affiliate `?uo=4` (and any other query) off an Apple album URL.
function cleanAppleUrl(u: string): string {
  return u.split("?")[0];
}

// iTunes keyword search is unreliable for indie/new releases (returns nothing
// even when the release exists on Apple Music). The robust path: find the
// artist, list their albums via lookup, and match by title. Falls back to a
// plain keyword search when the artist/title lookup can't pin it down.
async function appleFromItunes(
  title: string,
  artist: string,
): Promise<string | undefined> {
  const t = title.trim().toLowerCase();

  // Primary: artist → albums → title match.
  if (artist.trim()) {
    const a = await fetchJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(
        artist,
      )}&media=music&entity=musicArtist&limit=1&country=US`,
    );
    const artistId = a?.results?.[0]?.artistId;
    if (artistId && t) {
      const look = await fetchJson(
        `https://itunes.apple.com/lookup?id=${artistId}&entity=album&limit=200&country=US`,
      );
      const albums = (look?.results ?? []).filter(
        (x: Record<string, unknown>) =>
          x.wrapperType === "collection" && typeof x.collectionViewUrl === "string",
      );
      const match = albums.find((x: Record<string, unknown>) => {
        const n = String(x.collectionName ?? "").toLowerCase();
        return n === t || n.includes(t) || (t.length > 4 && t.includes(n));
      });
      if (match) return cleanAppleUrl(String(match.collectionViewUrl));
    }
  }

  // Fallback: keyword search (album, then any music entity).
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return undefined;
  const s = await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(
      q,
    )}&media=music&entity=album&limit=1&country=US`,
  );
  const r = s?.results?.[0];
  const url = (r?.collectionViewUrl as string) || (r?.trackViewUrl as string);
  return url ? cleanAppleUrl(url) : undefined;
}

// ── 3. Spotify Web API search (client-credentials) ───────────────────────────
async function spotifyToken(): Promise<string | null> {
  const id = Deno.env.get("SPOTIFY_CLIENT_ID");
  const secret = Deno.env.get("SPOTIFY_CLIENT_SECRET");
  if (!id || !secret) return null;
  const data = await fetchJson("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  return (data?.access_token as string) ?? null;
}

async function spotifyFromSearch(query: string): Promise<string | undefined> {
  if (!query.trim()) return undefined;
  const token = await spotifyToken();
  if (!token) return undefined;
  const api = `https://api.spotify.com/v1/search?q=${encodeURIComponent(
    query,
  )}&type=album,track&limit=1&market=US`;
  const data = await fetchJson(api, { headers: { Authorization: `Bearer ${token}` } });
  return (
    (data?.albums?.items?.[0]?.external_urls?.spotify as string) ||
    (data?.tracks?.items?.[0]?.external_urls?.spotify as string) ||
    undefined
  );
}

/**
 * Resolve the full DSP link set from a set of candidate seed URLs (destination +
 * any DSP URLs already in metadata). Returns only the keys that resolved.
 *
 * Strategy:
 *   1. Seed authority — every candidate that IS a DSP URL is kept verbatim.
 *   2. Odesli — run on the first candidate it can resolve; fill missing keys.
 *   3. Supplement — iTunes for a missing Apple link, Spotify for a missing
 *      Spotify link, using the title/artist Odesli reported.
 */
export async function resolvePlatformLinks(candidateUrls: string[]): Promise<PlatformLinks> {
  const seeds = candidateUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
  const out: PlatformLinks = {};

  // 1. Seed authority: keep any candidate that is itself a canonical DSP URL.
  for (const u of seeds) {
    const key = platformOf(u);
    if (key && !out[key]) out[key] = u;
  }

  // 2. Odesli: try each candidate until one resolves, then merge missing keys.
  let title = "";
  let artist = "";
  for (const seed of seeds) {
    const od = await fromOdesli(seed);
    if (!od) continue;
    for (const [k, v] of Object.entries(od.links) as [PlatformKey, string][]) {
      if (v && !out[k]) out[k] = v;
    }
    if (od.title && !title) title = od.title;
    if (od.artist && !artist) artist = od.artist;
    if (od.title || od.artist) break; // got usable metadata; stop probing
  }

  const query = [artist, title].filter(Boolean).join(" ").trim();

  // 3. Supplement the two big DSPs independently when Odesli missed them.
  if (!out.apple_music_url && (title || artist)) {
    const apple = await appleFromItunes(title, artist);
    if (apple) out.apple_music_url = apple;
  }
  if (!out.spotify_url && query) {
    const spotify = await spotifyFromSearch(query);
    if (spotify) out.spotify_url = spotify;
  }

  return out;
}
