import { firecrawlMarkdown, firecrawlScrape } from "./firecrawl.ts";

export type SpotifyPlaylistStub = {
  playlist_id: string;
  name: string;
  description?: string;
  owner_name?: string;
  owner_id?: string;
};

export type SpotifyPlaylistDetail = {
  name: string;
  description?: string;
  follower_count?: number;
  track_count?: number;
  owner_name?: string;
  owner_id?: string;
  track_artists?: string[];
  /** Individual track TITLES from the embed trackList — a second feel signal
   * alongside track_artists (e.g. "Gym Anthem", "After Hours", "Trap House"). */
  track_titles?: string[];
};

export type SpotifyUserProfile = {
  display_name?: string;
  bio?: string;
  follower_count?: number;
  following_count?: number;
  /** Curator-authored bio links only (preferred). */
  bio_links?: string[];
  /** Legacy extract field — do not use for IG when bio_links is present (even if empty). */
  social_links?: string[];
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    playlists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          playlist_id: {
            type: "string",
            description: "Spotify playlist ID from URL, e.g. 37i9dQZF1DX0XUsuxWHRQd",
          },
          name: { type: "string" },
          description: { type: "string" },
          owner_name: { type: "string" },
          owner_id: { type: "string" },
        },
        required: ["playlist_id", "name"],
      },
    },
  },
};

const USER_SCHEMA = {
  type: "object",
  properties: {
    display_name: { type: "string" },
    bio: {
      type: "string",
      description:
        "The user's own profile description / bio text. Do NOT include footer or page-chrome text. If the profile has no bio, return an empty string.",
    },
    bio_links: {
      type: "array",
      items: { type: "string" },
      description:
        "ONLY links in the user's own bio / about section. Do NOT include footer links, Verified Artist promotions, Spotify corporate accounts, or links not authored by the profile owner. If the bio has no links, return an empty array.",
    },
    follower_count: {
      type: "number",
      description: "Profile follower count shown on the user page (not playlist saves)",
    },
    following_count: {
      type: "number",
      description: "Number of accounts this user follows",
    },
  },
};

/**
 * Curator-authored bio links only.
 * If `bio_links` is present (including `[]`), do NOT fall back to `social_links` — empty means no bio links.
 * Legacy extracts with only `social_links` are read when `bio_links` was omitted entirely.
 */
export function profileCuratorBioLinks(profile: SpotifyUserProfile | null): string[] {
  if (!profile) return [];
  if (profile.bio_links !== undefined) return profile.bio_links;
  if (profile.social_links !== undefined) return profile.social_links;
  return [];
}

function normalizePlaylistId(raw: string): string {
  const m = raw.match(/([a-zA-Z0-9]{22})/);
  return m ? m[1] : raw.trim();
}

function parsePlaylistsFromMarkdown(md: string): SpotifyPlaylistStub[] {
  const seen = new Set<string>();
  const out: SpotifyPlaylistStub[] = [];
  const titled = /\[([^\]]{3,120})\]\(https?:\/\/open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/gi;
  let tm: RegExpExecArray | null;
  while ((tm = titled.exec(md)) !== null) {
    const id = tm[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ playlist_id: id, name: tm[1].trim() });
  }
  const re = /open\.spotify\.com\/playlist\/([a-zA-Z0-9]{22})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ playlist_id: id, name: `Playlist ${id.slice(0, 6)}…` });
  }
  return out;
}

function parseMetricCount(md: string): number | undefined {
  const m = md.match(/([\d,.]+)\s*([KkMm])?\s*(?:saves|followers|likes)/i);
  if (!m) return undefined;
  let n = parseFloat(m[1].replace(/,/g, ""));
  const suf = (m[2] ?? "").toUpperCase();
  if (suf === "K") n *= 1000;
  if (suf === "M") n *= 1_000_000;
  return Math.round(n);
}

export async function scrapeSpotifySearchPlaylists(
  query: string,
  opts?: { timeoutMs?: number },
): Promise<SpotifyPlaylistStub[]> {
  const url = `https://open.spotify.com/search/${encodeURIComponent(query)}/playlists`;
  try {
    const { markdown, extract } = await firecrawlScrape(url, { schema: SEARCH_SCHEMA, waitFor: 2000, timeoutMs: opts?.timeoutMs });
    const fromExtract = (extract?.playlists as SpotifyPlaylistStub[] | undefined) ?? [];
    if (fromExtract.length) {
      return fromExtract
        .map((p) => ({ ...p, playlist_id: normalizePlaylistId(p.playlist_id) }))
        .filter((p) => p.playlist_id.length >= 20);
    }
    return parsePlaylistsFromMarkdown(markdown);
  } catch (e) {
    console.error("[spotify-scrape] search failed:", query, e instanceof Error ? e.message : e);
    try {
      const md = await firecrawlMarkdown(url, 2000);
      return parsePlaylistsFromMarkdown(md);
    } catch {
      return [];
    }
  }
}

// The public /playlist/<id> page is a client-rendered SPA — Firecrawl gets an empty
// shell with no name/curator/followers, so enrichment failed on 100% of rows. These
// two endpoints are SERVER-rendered and need no auth or API key:
//   • the EMBED page carries a __NEXT_DATA__ JSON blob (name, owner, description, tracks)
//   • oEmbed returns at least the title
const EMBED_TIMEOUT_MS = 8_000;
const OEMBED_TIMEOUT_MS = 6_000;
const SPOTIFY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Bare GET with a browser UA + hard timeout. Returns the body text, or null on any
 * error / non-2xx (so callers fall through to the next channel). */
async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SPOTIFY_UA, "Accept": "text/html,application/json,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t ? t : undefined;
}

/** Pull the JSON out of the embed page's `<script id="__NEXT_DATA__">` blob (or the
 * older `id="resource"` variant). Returns the parsed object, or null if absent/malformed. */
function extractNextDataJson(html: string): unknown | null {
  if (!html) return null;
  const candidates = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]*id=["'](?:resource|initial-state|session)["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[1].trim());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Depth-first search for the playlist entity inside the __NEXT_DATA__ tree. Prefers
 * an object that carries a `trackList` (the fully-hydrated entity); falls back to any
 * playlist-typed object with a name. Guards against cycles. */
function findPlaylistEntity(root: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  let fallback: Record<string, unknown> | null = null;
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    const hasName = typeof obj.name === "string" || typeof obj.title === "string";
    if (Array.isArray(obj.trackList) && hasName) return obj;
    if (!fallback && obj.type === "playlist" && hasName) fallback = obj;
    for (const k in obj) stack.push(obj[k]);
  }
  return fallback;
}

/** Best-effort owner/curator name. Embed entities expose it inconsistently
 * (`subtitle`, an `owner` object, `ownerName`, …), so probe the known shapes. */
function ownerFromEntity(entity: Record<string, unknown>): string | undefined {
  const owner = entity.owner;
  if (owner && typeof owner === "object") {
    const o = owner as Record<string, unknown>;
    const n = pickString(o.name) ?? pickString(o.display_name) ?? pickString(o.displayName);
    if (n) return n;
  }
  return (
    pickString(entity.subtitle) ??
    pickString(entity.ownerName) ??
    pickString((entity as { owner_name?: unknown }).owner_name) ??
    pickString(typeof owner === "string" ? owner : undefined)
  );
}

/** Split a track's "Artist A, Artist B feat. C" subtitle into individual artist names.
 * Splits on separators and collab words, then trims stray punctuation (e.g. the "."
 * left behind by "feat.") off each piece. */
function splitArtists(subtitle: string): string[] {
  return subtitle
    .split(/,|;|&|·|\/|\bfeat\b|\bft\b|\bfeaturing\b|\bwith\b/i)
    .map((s) => s.replace(/^[\s.,&·/-]+|[\s.,&·/-]+$/g, "").trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a Spotify EMBED page's HTML into playlist metadata. Pure and dependency-free
 * so it unit-tests without any network. Returns null when the page has no usable
 * __NEXT_DATA__ / entity / name. Follower count is NOT present on the embed page, so
 * it is intentionally left undefined (never 0).
 */
export function parseEmbedNextData(html: string): SpotifyPlaylistDetail | null {
  const json = extractNextDataJson(html);
  if (!json) return null;
  const entity = findPlaylistEntity(json);
  if (!entity) return null;
  const name = pickString(entity.name) ?? pickString(entity.title);
  if (!name) return null;

  const detail: SpotifyPlaylistDetail = { name };

  const description = pickString(entity.description) ??
    stripHtml(pickString((entity as { htmlDescription?: unknown }).htmlDescription));
  if (description) detail.description = description;

  const owner = ownerFromEntity(entity);
  if (owner) detail.owner_name = owner;
  const ownerId = pickString((entity.owner as { id?: unknown })?.id) ??
    pickString((entity as { ownerId?: unknown }).ownerId);
  if (ownerId) detail.owner_id = ownerId;

  if (Array.isArray(entity.trackList)) {
    detail.track_count = entity.trackList.length;
    const artists: string[] = [];
    const titles: string[] = [];
    for (const t of entity.trackList) {
      const sub = pickString((t as { subtitle?: unknown })?.subtitle);
      if (sub) artists.push(...splitArtists(sub));
      const title = pickString((t as { title?: unknown })?.title) ??
        pickString((t as { name?: unknown })?.name);
      if (title) titles.push(title);
    }
    detail.track_artists = [...new Set(artists)].slice(0, 40);
    if (titles.length) detail.track_titles = [...new Set(titles)].slice(0, 40);
  }
  return detail;
}

/** Parse Spotify oEmbed JSON. Only the title is reliably present (no auth needed). */
export function parseOEmbedTitle(jsonText: string): string | null {
  try {
    const o = JSON.parse(jsonText) as { title?: unknown };
    return pickString(o.title) ?? null;
  } catch {
    return null;
  }
}

export async function scrapeSpotifyPlaylistDetail(
  playlistId: string,
  opts?: { timeoutMs?: number },
): Promise<SpotifyPlaylistDetail | null> {
  const id = normalizePlaylistId(playlistId);

  // Channel 1 (primary) — the server-rendered EMBED page. Try a direct fetch first
  // (fast, free, no Firecrawl budget); if that's blocked or returns a shell with no
  // __NEXT_DATA__, fall back to Firecrawl's rawHtml of the same URL.
  const embedUrl = `https://open.spotify.com/embed/playlist/${id}`;
  let html = await fetchText(embedUrl, opts?.timeoutMs ?? EMBED_TIMEOUT_MS);
  if (!html || !html.includes("__NEXT_DATA__")) {
    try {
      const { rawHtml, html: cleaned } = await firecrawlScrape(embedUrl, {
        formats: ["rawHtml"],
        waitFor: 0,
        timeoutMs: opts?.timeoutMs,
      });
      html = rawHtml || cleaned || html || "";
    } catch (e) {
      console.error("[spotify-scrape] embed firecrawl failed:", id, e instanceof Error ? e.message : e);
    }
  }
  const fromEmbed = html ? parseEmbedNextData(html) : null;
  if (fromEmbed?.name) return fromEmbed;

  // Channel 2 (fallback) — oEmbed, which returns at least the title so we can still
  // populate a real playlist_name and clear the placeholder stub.
  const oembedUrl =
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/playlist/${id}`)}`;
  const oeText = await fetchText(oembedUrl, opts?.timeoutMs ?? OEMBED_TIMEOUT_MS);
  const title = oeText ? parseOEmbedTitle(oeText) : null;
  if (title) return { name: title };

  console.error("[spotify-scrape] playlist detail: no server-rendered metadata for", id);
  return null;
}

export async function scrapeSpotifyUserProfile(
  userId: string,
  opts?: { timeoutMs?: number },
): Promise<SpotifyUserProfile | null> {
  const url = `https://open.spotify.com/user/${userId}`;
  try {
    const { markdown, extract } = await firecrawlScrape(url, { schema: USER_SCHEMA, waitFor: 2000, timeoutMs: opts?.timeoutMs });
    if (extract && typeof extract === "object") {
      const profile = extract as SpotifyUserProfile;
      // Do not copy social_links → bio_links (chrome links must not masquerade as bio_links).
      if (profile.follower_count == null && markdown) {
        profile.follower_count = parseMetricCount(markdown);
      }
      return profile;
    }
    // No markdown IG fallback — page chrome would match instagram.com/spotify first.
    console.warn("[spotify-scrape] user profile extract empty:", userId);
    return null;
  } catch (e) {
    console.error("[spotify-scrape] user profile failed:", userId, e instanceof Error ? e.message : e);
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * result. A pool of `concurrency` workers pulls from a shared cursor, so at most
 * `concurrency` scrapes are in flight at once — this replaces the old
 * sequential-await + fixed-sleep pacing (much faster wall-clock, same external
 * load ceiling). `shouldContinue` is checked before each item is started; once it
 * returns false, no further items are launched and their slots stay `undefined`
 * (callers filter those out). A throwing `fn` yields `undefined` for that slot
 * rather than rejecting the whole pool.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldContinue: () => boolean = () => true,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length || 1));
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      if (!shouldContinue()) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
