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
  owner_name?: string;
  owner_id?: string;
  track_artists?: string[];
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

const PLAYLIST_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    follower_count: {
      type: "number",
      description: "Playlist save count or follower count shown on the page (e.g. 1033 saves)",
    },
    owner_name: { type: "string" },
    owner_id: { type: "string" },
    track_artists: {
      type: "array",
      items: { type: "string" },
      description: "Artist names from visible tracks",
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

function parseUserIdFromMarkdown(md: string): string | null {
  const m = md.match(/open\.spotify\.com\/user\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
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

export async function scrapeSpotifySearchPlaylists(query: string): Promise<SpotifyPlaylistStub[]> {
  const url = `https://open.spotify.com/search/${encodeURIComponent(query)}/playlists`;
  try {
    const { markdown, extract } = await firecrawlScrape(url, { schema: SEARCH_SCHEMA, waitFor: 2000 });
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

export async function scrapeSpotifyPlaylistDetail(playlistId: string): Promise<SpotifyPlaylistDetail | null> {
  const id = normalizePlaylistId(playlistId);
  const url = `https://open.spotify.com/playlist/${id}`;
  try {
    const { markdown, extract } = await firecrawlScrape(url, { schema: PLAYLIST_SCHEMA, waitFor: 2000 });
    if (extract && typeof extract === "object" && extract.name) {
      const d = extract as SpotifyPlaylistDetail;
      if (!d.owner_id && markdown) d.owner_id = parseUserIdFromMarkdown(markdown) ?? undefined;
      if (d.follower_count == null && markdown) d.follower_count = parseMetricCount(markdown);
      return d;
    }
    const owner_id = parseUserIdFromMarkdown(markdown);
    const follower_count = parseMetricCount(markdown);
    if (!markdown && !owner_id) return null;
    return {
      name: `Playlist ${id.slice(0, 8)}`,
      owner_id: owner_id ?? undefined,
      follower_count,
      track_artists: [],
    };
  } catch (e) {
    console.error("[spotify-scrape] playlist detail failed:", id, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function scrapeSpotifyUserProfile(userId: string): Promise<SpotifyUserProfile | null> {
  const url = `https://open.spotify.com/user/${userId}`;
  try {
    const { markdown, extract } = await firecrawlScrape(url, { schema: USER_SCHEMA, waitFor: 2000 });
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
