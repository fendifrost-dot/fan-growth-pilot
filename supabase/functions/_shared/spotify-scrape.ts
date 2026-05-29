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
    follower_count: { type: "number" },
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
    bio: { type: "string" },
    social_links: { type: "array", items: { type: "string" } },
  },
};

function normalizePlaylistId(raw: string): string {
  const m = raw.match(/([a-zA-Z0-9]{22})/);
  return m ? m[1] : raw.trim();
}

function parsePlaylistsFromMarkdown(md: string): SpotifyPlaylistStub[] {
  const seen = new Set<string>();
  const out: SpotifyPlaylistStub[] = [];
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

function parseFollowers(md: string): number | undefined {
  const m = md.match(/([\d,.]+)\s*([KkMm])?\s*followers/i);
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
      if (d.follower_count == null && markdown) d.follower_count = parseFollowers(markdown);
      return d;
    }
    const owner_id = parseUserIdFromMarkdown(markdown);
    const follower_count = parseFollowers(markdown);
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
      if (!profile.social_links?.length && markdown) {
        profile.social_links = extractUrlsFromMarkdown(markdown);
      }
      return profile;
    }
    if (!markdown) return null;
    return {
      display_name: undefined,
      bio: markdown.slice(0, 2000),
      social_links: extractUrlsFromMarkdown(markdown),
    };
  } catch (e) {
    console.error("[spotify-scrape] user profile failed:", userId, e instanceof Error ? e.message : e);
    return null;
  }
}

function extractUrlsFromMarkdown(md: string): string[] {
  const urls = md.match(/https?:\/\/[^\s)\]"']+/g) ?? [];
  return [...new Set(urls)].slice(0, 20);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
