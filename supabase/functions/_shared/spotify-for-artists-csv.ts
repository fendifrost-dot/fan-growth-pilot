import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isSpotifyOwnedCurator, isArtistAsCurator } from "./curator-filters.ts";
import { isWarmPlacementSource } from "./placement-sources.ts";
import { SFA_PLACEHOLDER_TRACK } from "./placement-match.ts";
import { scrapeSpotifySearchPlaylists, sleep } from "./spotify-scrape.ts";

export type SfaCsvRow = {
  title: string;
  author: string;
  listeners: number;
  streams: number;
  date_added: string | null;
  /** The SONG this playlist row is reporting a placement of — i.e. which of our tracks
   * the curator added. NOT the playlist name (that's `title`).
   *
   * Usually null: the standard Spotify-for-Artists "playlists" export has only
   * title/author/listeners/streams/date_added columns — the song is implicit in the
   * export's context (you drill into ONE song, then export its playlists), so it never
   * appears as a column. Populated only when the export variant does carry a song
   * column; otherwise the caller must supply it via `opts.song_name`. */
  song: string | null;
};

/** Header spellings seen across Spotify-for-Artists export variants for the song column.
 * Checked in order; the first present column wins. Deliberately does NOT include
 * "title" — in this export "title" is the PLAYLIST name, and treating it as the song
 * is exactly the confusion that produced placement rows naming a playlist as a track. */
const SFA_SONG_HEADERS = ["song", "track", "song name", "track name", "song_name", "track_name"];

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
  // Optional — most SFA exports have no song column at all (see SfaCsvRow.song).
  const gi = SFA_SONG_HEADERS.map((h) => header.indexOf(h)).find((i) => i >= 0) ?? -1;
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
      song: gi >= 0 && cols[gi] && cols[gi] !== "n/a" ? cols[gi].trim() || null : null,
    });
  }
  return rows;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Merge a CSV import's research_context over the row's existing one.
 *
 * Everything merges "existing loses to incoming, missing keys survive" — except
 * `featuring_tracks`, where plain spreading is wrong in BOTH directions:
 *   - incoming wins → a real song name found by another pass gets clobbered;
 *   - existing survives → a legacy placeholder is inherited forever.
 * So the caller resolves that key up front (union of real names, placeholder stripped)
 * and passes the result here as the single source of truth: present when non-empty,
 * explicitly DELETED otherwise so no placeholder can leak through from `existingRc`.
 */
export function mergeSfaResearchContext(
  existingRc: Record<string, unknown> | null,
  incomingRc: Record<string, unknown>,
  mergedFeaturing: string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = existingRc ? { ...existingRc, ...incomingRc } : { ...incomingRc };
  if (mergedFeaturing.length) merged.featuring_tracks = mergedFeaturing;
  else delete merged.featuring_tracks;
  return merged;
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
    /** Which SONG this report covers, when the CSV itself doesn't say (the usual case:
     * the standard SFA playlists export has no song column — you drill into one song in
     * the SFA UI, then export ITS playlists, so the song is context, not data).
     *
     * Supplying it is what lets an import record a REAL placement — "this curator added
     * THIS track" — instead of only "a track of ours was added, unknown which". A CSV
     * `song` column, where one exists, takes precedence over this per-row. */
    song_name?: string;
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
  const importSongName = (opts.song_name ?? "").trim() || null;
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
    // The song this row reports a placement of: CSV column first (rare), then the
    // caller-declared song_name for the whole report. Null when neither is available.
    const songName = row.song ?? importSongName;
    const researchContext: Record<string, unknown> = {
      source: "spotify_for_artists_csv",
      artist_name: artistName,
      sfa_listeners: row.listeners,
      sfa_streams: row.streams,
      sfa_date_added: row.date_added,
      sfa_period_label: periodLabel,
      sfa_imported_at: now,
      engagement_recommended: "thank_and_pitch",
      // An SFA row is proof that SOME track of ours was added — that's what the report
      // means — but the export usually doesn't say WHICH. Record that as a flag, not as
      // a fake track name: `featuring_tracks` is consumed as real song data (ranked on
      // by placement-match, rendered in the admin UI, and interpolated into outreach
      // copy as "featuring <x>"), so a placeholder there reads as data and, worse, ships
      // to curators. When the song is unknown we now write NO featuring_tracks at all
      // and let these two flags carry the honest, machine-readable truth.
      sfa_confirms_placement: true,
      // Set below, once this row's real names are resolved against what's already
      // stored — the answer depends on the existing row, not just on this CSV.
      sfa_song_name_known: false,
    };

    // Fetch existing enrichment BEFORE upsert so a metadata-only CSV refresh
    // (which carries no URL, no vibe/curator data) never null-clobbers richer
    // data written by earlier research/enrichment passes.
    const { data: existing } = await sb.from("playlist_targets")
      .select("playlist_id, submission_url, curator_name, follower_count, vibe_tags, similar_artists, research_context")
      .eq("playlist_id", playlistId)
      .maybeSingle();

    const existingRc = (existing?.research_context as Record<string, unknown> | null) ?? null;
    const existingVibeTags = (existing?.vibe_tags as string[] | null) ?? null;
    const existingSimilar = (existing?.similar_artists as string[] | null) ?? null;

    // featuring_tracks is UNION-merged, never clobbered — and the legacy placeholder is
    // dropped on contact. Three things this gets right that a plain spread did not:
    //   1. A real name found by another pass (placement discovery, the sweep's tracklist
    //      bridge) SURVIVES a metadata-only CSV re-import. The old code always spread a
    //      placeholder-bearing researchContext over the existing one, so every re-import
    //      silently overwrote real song names with the placeholder — which is why an
    //      earlier attempt to backfill these names did not stick.
    //   2. Two reports for different songs on the same playlist accumulate both, rather
    //      than the newer import erasing the older placement.
    //   3. Historical placeholder values are stripped wherever they're encountered, so a
    //      re-import doubles as the backfill for rows already carrying one.
    // Empty result → the key is omitted entirely rather than written as [], so a row
    // never asserts "features nothing".
    const mergedFeaturing = (() => {
      const prior = Array.isArray(existingRc?.featuring_tracks) ? existingRc.featuring_tracks : [];
      const names = [...prior.map((t) => String(t ?? "").trim()), ...(songName ? [songName] : [])]
        .filter((t) => t.length > 0 && normalizeKey(t) !== normalizeKey(SFA_PLACEHOLDER_TRACK));
      return [...new Map(names.map((n) => [normalizeKey(n), n])).values()];
    })();
    // Reflect what the row actually ends up asserting, not just what this CSV carried:
    // a row whose song name came from an earlier pass is still "known". The
    // featuring_tracks key itself is applied by mergeSfaResearchContext below.
    researchContext.sfa_song_name_known = mergedFeaturing.length > 0;

    const dbRow = {
      playlist_id: playlistId,
      platform: "spotify",
      playlist_name: row.title,
      // Preserve a real curator name if the CSV row has none for this author.
      curator_name: curator ?? existing?.curator_name ?? null,
      // CSV listeners can be 0 (parse fallback); don't wipe a real follower count.
      follower_count: row.listeners > 0 ? row.listeners : (existing?.follower_count ?? 0),
      track_count: 0,
      overlap_score: Math.min(95, 50 + Math.min(row.streams, 40)),
      fraud_score: 15,
      fraud_verdict: "safe",
      pitch_status: "not_pitched",
      tier: 1,
      whitelist_status: false,
      // The SFA CSV carries no vibe tags / similar artists — keep existing ones.
      vibe_tags: existingVibeTags && existingVibeTags.length ? existingVibeTags : ([] as string[]),
      similar_artists: references.length ? references.slice(0, 8) : (existingSimilar ?? []),
      submission_method: "instagram_dm",
      // CONFIRMED BUG FIX: the SFA CSV has no URL column, so submissionUrl is
      // usually null — never overwrite a previously-resolved real playlist URL.
      submission_url: submissionUrl ?? existing?.submission_url ?? null,
      is_active: true,
      why_it_fits: `Spotify for Artists: ${row.streams} streams · ${row.listeners} listeners in report period.`,
      // Merge over existing research_context so enrichment keys aren't erased.
      // mergeSfaResearchContext handles the one key where "don't erase" is the WRONG
      // default: a legacy placeholder in existingRc must be dropped, not inherited.
      research_context: mergeSfaResearchContext(existingRc, researchContext, mergedFeaturing),
      ...(lane ? { lane } : {}),
    };

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
