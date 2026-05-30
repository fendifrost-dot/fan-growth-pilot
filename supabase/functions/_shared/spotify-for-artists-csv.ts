import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isSpotifyOwnedCurator, isArtistAsCurator } from "./curator-filters.ts";
import { isWarmPlacementSource } from "./placement-sources.ts";
import { scrapeSpotifySearchPlaylists, sleep } from "./spotify-scrape.ts";

export type SfaCsvRow = {
  title: string;
  author: string;
  listeners: number;
  streams: number;
  date_added: string | null;
};

export type SfaImportResult = {
  parsed: number;
  ingested: number;
  updated: number;
  skipped: Record<string, number>;
  period_label: string | null;
};

const SFA_ALGORITHMIC_TITLES = [
  /^radio$/i,
  /^mixes$/i,
  /^your dj$/i,
  /^smart shuffle$/i,
  /^on repeat$/i,
  /^daylist$/i,
  /^discover weekly$/i,
  /^release radar$/i,
  /^repeat rewind$/i,
  /^blend$/i,
  /^your summer rewind$/i,
  /^your top songs \d{4}$/i,
  /^this is /i,
];

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseIntSafe(v: string): number {
  const n = parseInt(String(v ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

export function parseSpotifyForArtistsCsv(text: string): SfaCsvRow[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = parseCsvRow(lines[0]).map((h) => h.toLowerCase());
  const ti = header.indexOf("title");
  const ai = header.indexOf("author");
  const li = header.indexOf("listeners");
  const si = header.indexOf("streams");
  const di = header.indexOf("date_added");
  if (ti < 0 || ai < 0) {
    throw new Error("CSV must have title and author columns (Spotify for Artists export)");
  }

  const rows: SfaCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const title = cols[ti] ?? "";
    if (!title.trim()) continue;
    const author = (cols[ai] ?? "").trim() || "-";
    rows.push({
      title: title.trim(),
      author,
      listeners: li >= 0 ? parseIntSafe(cols[li]) : 0,
      streams: si >= 0 ? parseIntSafe(cols[si]) : 0,
      date_added: di >= 0 && cols[di] && cols[di] !== "n/a" ? cols[di].trim() : null,
    });
  }
  return rows;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function stableSfaPlaylistId(title: string, author: string): Promise<string> {
  const key = `${normalizeKey(title)}|${normalizeKey(author)}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 22);
  return `spotify:sfa:${hex}`;
}

function isSfaAlgorithmicTitle(title: string): boolean {
  return SFA_ALGORITHMIC_TITLES.some((re) => re.test(title.trim()));
}

function curatorDisplay(author: string): string | null {
  const a = author.trim();
  if (!a || a === "-") return null;
  return a;
}

async function tryResolveRealPlaylistId(
  title: string,
  artistName: string,
): Promise<{ playlist_id: string; submission_url: string } | null> {
  if (!Deno.env.get("FIRECRAWL_API_KEY")) return null;
  try {
    const stubs = await scrapeSpotifySearchPlaylists(`${title} ${artistName}`);
    const want = normalizeKey(title);
    for (const s of stubs.slice(0, 8)) {
      if (!s.playlist_id || s.playlist_id.startsWith("37i9dQZF")) continue;
      if (normalizeKey(s.name ?? "") === want || normalizeKey(s.name ?? "").includes(want.slice(0, 12))) {
        return {
          playlist_id: `spotify:${s.playlist_id}`,
          submission_url: `https://open.spotify.com/playlist/${s.playlist_id}`,
        };
      }
    }
    await sleep(600);
  } catch (e) {
    console.error("[sfa-csv] resolve", title, e instanceof Error ? e.message : e);
  }
  return null;
}

export async function importSpotifyForArtistsCsv(
  sb: SupabaseClient,
  opts: {
    csv_text: string;
    period_label?: string;
    lane?: string;
    references?: string[];
    artist_name?: string;
    resolve_urls?: boolean;
    resolve_limit?: number;
    deactivate_missing?: boolean;
  },
): Promise<SfaImportResult> {
  const rows = parseSpotifyForArtistsCsv(opts.csv_text);
  const periodLabel = (opts.period_label ?? "").trim() || null;
  const lane = (opts.lane ?? "").trim();
  const references = opts.references ?? [];
  const artistName = (opts.artist_name ?? Deno.env.get("ARTIST_DISPLAY_NAME") ?? "Fendi Frost").trim();
  const resolveUrls = Boolean(opts.resolve_urls);
  const resolveLimit = Math.min(25, Math.max(0, Number(opts.resolve_limit) || 12));
  const deactivateMissing = Boolean(opts.deactivate_missing);

  const skipped: Record<string, number> = {
    spotify_owned: 0,
    algorithmic_title: 0,
    artist_curator: 0,
    low_signal: 0,
    parse_error: 0,
  };

  const importedIds = new Set<string>();
  let ingested = 0;
  let updated = 0;
  let resolveUsed = 0;

  for (const row of rows) {
    if (row.streams < 1 && row.listeners < 1) {
      skipped.low_signal++;
      continue;
    }

    const curator = curatorDisplay(row.author);
    if (isSpotifyOwnedCurator(curator ?? row.author, row.title, null)) {
      skipped.spotify_owned++;
      continue;
    }
    if (isSfaAlgorithmicTitle(row.title)) {
      skipped.algorithmic_title++;
      continue;
    }
    if (isArtistAsCurator(curator, [...references, artistName])) {
      skipped.artist_curator++;
      continue;
    }

    let playlistId = await stableSfaPlaylistId(row.title, row.author);
    let submissionUrl: string | null = null;

    if (resolveUrls && resolveUsed < resolveLimit) {
      const resolved = await tryResolveRealPlaylistId(row.title, artistName);
      if (resolved) {
        playlistId = resolved.playlist_id;
        submissionUrl = resolved.submission_url;
        resolveUsed++;
      }
    }

    importedIds.add(playlistId);
    const now = new Date().toISOString();
    const researchContext = {
      source: "spotify_for_artists_csv",
      artist_name: artistName,
      sfa_listeners: row.listeners,
      sfa_streams: row.streams,
      sfa_date_added: row.date_added,
      sfa_period_label: periodLabel,
      sfa_imported_at: now,
      engagement_recommended: "thank_and_pitch",
      featuring_tracks: ["(from Spotify for Artists playlist report)"],
    };

    const dbRow = {
      playlist_id: playlistId,
      platform: "spotify",
      playlist_name: row.title,
      curator_name: curator,
      follower_count: row.listeners,
      track_count: 0,
      overlap_score: Math.min(95, 50 + Math.min(row.streams, 40)),
      fraud_score: 15,
      fraud_verdict: "safe",
      pitch_status: "not_pitched",
      tier: 1,
      whitelist_status: false,
      vibe_tags: [] as string[],
      similar_artists: references.slice(0, 8),
      submission_method: "instagram_dm",
      submission_url: submissionUrl,
      is_active: true,
      why_it_fits: `Spotify for Artists: ${row.streams} streams · ${row.listeners} listeners in report period.`,
      research_context: researchContext,
      ...(lane ? { lane } : {}),
    };

    const { data: existing } = await sb.from("playlist_targets")
      .select("playlist_id, research_context")
      .eq("playlist_id", playlistId)
      .maybeSingle();

    const { error } = await sb.from("playlist_targets").upsert(dbRow, { onConflict: "playlist_id" });
    if (error) {
      skipped.parse_error++;
      console.error("[sfa-csv] upsert", playlistId, error.message);
      continue;
    }
    if (existing?.playlist_id) updated++;
    else ingested++;
  }

  if (deactivateMissing && importedIds.size > 0) {
    const { data: prior } = await sb.from("playlist_targets")
      .select("playlist_id, research_context")
      .eq("is_active", true)
      .filter("research_context->>source", "eq", "spotify_for_artists_csv");

    for (const p of prior ?? []) {
      if (importedIds.has(p.playlist_id)) continue;
      const rc = p.research_context as Record<string, unknown> | null;
      if (rc?.sfa_period_label && periodLabel && rc.sfa_period_label !== periodLabel) continue;
      await sb.from("playlist_targets").update({
        is_active: false,
        pitch_status: "sfa_csv_removed",
      }).eq("playlist_id", p.playlist_id);
    }
  }

  return {
    parsed: rows.length,
    ingested,
    updated,
    skipped,
    period_label: periodLabel,
  };
}

/** PostgREST filter fragment for warm placement rows. */
export function warmPlacementSourceOrFilter(): string {
  return "research_context->>source.eq.spotify_placement,research_context->>source.eq.spotify_for_artists_csv";
}

export function rowIsWarmPlacement(row: { research_context?: unknown }): boolean {
  const rc = row.research_context as Record<string, unknown> | null;
  return isWarmPlacementSource(rc?.source as string | undefined);
}
