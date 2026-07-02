// Album/track artwork resolver for smart links.
//
// Given the streaming destinations a smart link points to, fetch the official
// cover art at the highest resolution available. Strategy, in priority order:
//   1. Apple Music / iTunes  → iTunes Lookup API, upgraded to 1000x1000  (best)
//   2. Spotify               → oEmbed thumbnail, CDN size code upgraded to 640
//   3. og:image scrape       → last-resort fallback for any other page
//
// Official artwork endpoints are preferred over scraping for quality.

export interface ArtworkResult {
  imageUrl: string;
  source: "apple" | "spotify" | "ogimage";
  width: number | null;
  height: number | null;
  bytes: number;
  contentType: string;
}

const UA =
  "Mozilla/5.0 (compatible; FendiFrostArtworkBot/1.0; +https://links.fendifrost.com)";

// music.apple.com/us/album/nutrition/6785312459  or  ...?i=6785312459 (track)
const APPLE_ALBUM_RE = /music\.apple\.com\/[^?#]*?\/(\d{3,})(?:[/?#]|$)/i;
const APPLE_TRACK_QS_RE = /[?&]i=(\d{3,})/;
// open.spotify.com/album/ID , /track/ID , with optional /intl-xx/ prefix
const SPOTIFY_RE =
  /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:album|track|playlist)\/[A-Za-z0-9]+/i;

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    return null;
  }
}

/** Parse width/height from the leading bytes of a PNG or JPEG buffer. */
function readImageDimensions(
  buf: Uint8Array,
): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR chunk with width@16, height@20 (big-endian)
  if (
    buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // JPEG: scan for a Start-Of-Frame marker (0xFFC0..0xFFCF, excluding C4/C8/CC)
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = (buf[i + 5] << 8) | buf[i + 6];
        const width = (buf[i + 7] << 8) | buf[i + 8];
        return { width, height };
      }
      const segLen = (buf[i + 2] << 8) | buf[i + 3];
      if (segLen < 2) break;
      i += 2 + segLen;
    }
  }
  return null;
}

/**
 * Verify a candidate image URL actually resolves and is high-res.
 * Requires: HTTP 200, an image content-type, and either parsed dimensions
 * >= minWidth or (when dimensions are unreadable) a byte size that implies
 * a real cover rather than a placeholder.
 */
async function verifyImage(
  url: string,
  minWidth: number,
): Promise<
  { ok: boolean; width: number | null; height: number | null; bytes: number; contentType: string; buffer: Uint8Array }
> {
  const fail = {
    ok: false,
    width: null,
    height: null,
    bytes: 0,
    contentType: "",
    buffer: new Uint8Array(),
  };
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return fail;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return fail;
    const buffer = new Uint8Array(await res.arrayBuffer());
    const bytes = buffer.length;
    const dims = readImageDimensions(buffer);
    const width = dims?.width ?? null;
    const height = dims?.height ?? null;
    // High-res gate: trust parsed width when available, else fall back to a
    // generous byte threshold (~20KB) so we never save a tiny placeholder.
    const highRes = width !== null ? width >= minWidth : bytes >= 20_000;
    if (!highRes) return { ...fail, width, height, bytes, contentType, buffer };
    return { ok: true, width, height, bytes, contentType, buffer };
  } catch (_e) {
    return fail;
  }
}

/** Apple Music / iTunes → 1000x1000 artwork. */
async function fromApple(url: string): Promise<string | null> {
  const id = url.match(APPLE_TRACK_QS_RE)?.[1] ?? url.match(APPLE_ALBUM_RE)?.[1];
  if (!id) return null;
  const data = await fetchJson(`https://itunes.apple.com/lookup?id=${id}`);
  const raw: string | undefined = data?.results?.[0]?.artworkUrl100 ??
    data?.results?.[0]?.artworkUrl60;
  if (!raw) return null;
  // .../100x100bb.jpg → .../1000x1000bb.jpg
  return raw.replace(/\/\d+x\d+bb\.(jpg|png)/i, "/1000x1000bb.$1");
}

/** Spotify → oEmbed thumbnail upgraded to the 640px CDN variant. */
async function fromSpotify(url: string): Promise<string | null> {
  if (!SPOTIFY_RE.test(url)) return null;
  const data = await fetchJson(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  );
  const thumb: string | undefined = data?.thumbnail_url;
  if (!thumb) return null;
  // Spotify CDN size codes: 00001e02 = 300px, 0000b273 = 640px. Upgrade if present.
  return thumb.replace(/ab67616d0000[0-9a-f]{4}/i, "ab67616d0000b273");
}

/** Any page → its og:image / twitter:image meta tag. */
async function fromOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the best available artwork from a set of candidate streaming URLs.
 * Tries official endpoints (Apple, then Spotify) first, then og:image scrape,
 * and verifies each candidate resolves & is high-res before returning it.
 */
export async function resolveArtwork(
  candidateUrls: string[],
): Promise<ArtworkResult | null> {
  const urls = candidateUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));

  const attempts: Array<{ resolver: () => Promise<string | null>; source: ArtworkResult["source"]; minWidth: number }> = [];

  const appleUrl = urls.find((u) => /music\.apple\.com/i.test(u));
  if (appleUrl) attempts.push({ resolver: () => fromApple(appleUrl), source: "apple", minWidth: 600 });

  const spotifyUrl = urls.find((u) => SPOTIFY_RE.test(u));
  if (spotifyUrl) attempts.push({ resolver: () => fromSpotify(spotifyUrl), source: "spotify", minWidth: 500 });

  // og:image fallback — try each distinct page (destination first via caller order)
  for (const u of urls) {
    attempts.push({ resolver: () => fromOgImage(u), source: "ogimage", minWidth: 300 });
  }

  for (const attempt of attempts) {
    const candidate = await attempt.resolver();
    if (!candidate) continue;
    const v = await verifyImage(candidate, attempt.minWidth);
    if (v.ok) {
      return {
        imageUrl: candidate,
        source: attempt.source,
        width: v.width,
        height: v.height,
        bytes: v.bytes,
        contentType: v.contentType,
      };
    }
  }
  return null;
}

/** Collect every plausible DSP/streaming URL from a smart_links row. */
export function gatherCandidateUrls(link: {
  destination_url?: string | null;
  metadata?: Record<string, unknown> | null;
}): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  };
  const md = (link.metadata ?? {}) as Record<string, unknown>;
  // Explicit per-platform fields on the metadata blob
  push(md.apple_music_url);
  push(md.spotify_url);
  push(md.tidal_url);
  push(md.youtube_url);
  // The multi-platform chooser array: [{ key, url, label }]
  if (Array.isArray(md.platforms)) {
    for (const p of md.platforms as Array<Record<string, unknown>>) push(p?.url);
  }
  // The public destination last (often an aggregator like even.biz / rnd.fm)
  push(link.destination_url);
  // De-dupe, preserve order
  return [...new Set(out)];
}
