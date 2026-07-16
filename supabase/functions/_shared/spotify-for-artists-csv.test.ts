// Guards for the two SFA-import behaviours that made placement reporting misleading:
//   1. the parser now recovers a real song name when the export carries one;
//   2. featuring_tracks merges (union, placeholder stripped) instead of being clobbered
//      by a placeholder on every re-import — the reason an earlier attempt to backfill
//      real song names never stuck.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mergeSfaResearchContext, parseSpotifyForArtistsCsv } from "./spotify-for-artists-csv.ts";
import { SFA_PLACEHOLDER_TRACK } from "./placement-match.ts";

Deno.test("parse: the standard export has no song column → song is null", () => {
  const rows = parseSpotifyForArtistsCsv(
    "title,author,listeners,streams,date_added\nDark Rap,Curator A,120,340,2026-01-02",
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].title, "Dark Rap");
  assertEquals(rows[0].song, null);
});

Deno.test("parse: a song column, when present, is captured", () => {
  const rows = parseSpotifyForArtistsCsv(
    "song,title,author,listeners,streams\nExhausting,Dark Rap,Curator A,120,340",
  );
  assertEquals(rows[0].song, "Exhausting");
  // `title` stays the PLAYLIST name — never confused for the song.
  assertEquals(rows[0].title, "Dark Rap");
});

Deno.test("parse: alternate song header spellings are recognised", () => {
  for (const h of ["track", "song name", "track_name"]) {
    const rows = parseSpotifyForArtistsCsv(`${h},title,author,listeners,streams\nKompressa,Yuhhh,Cur,1,2`);
    assertEquals(rows[0].song, "Kompressa");
  }
});

Deno.test("merge: a real song name SURVIVES a metadata-only re-import", () => {
  // The regression that mattered: existing row knows the song, the CSV doesn't.
  const merged = mergeSfaResearchContext(
    { featuring_tracks: ["Exhausting"], source: "spotify_for_artists_csv" },
    { source: "spotify_for_artists_csv", sfa_streams: 9 },
    ["Exhausting"],
  );
  assertEquals(merged.featuring_tracks, ["Exhausting"]);
  assertEquals(merged.sfa_streams, 9);
});

Deno.test("merge: the legacy placeholder is stripped, not inherited", () => {
  const merged = mergeSfaResearchContext(
    { featuring_tracks: [SFA_PLACEHOLDER_TRACK] },
    { source: "spotify_for_artists_csv" },
    [],
  );
  // Absent entirely — NOT [] — so the row never asserts "features nothing".
  assertEquals("featuring_tracks" in merged, false);
});

Deno.test("merge: two reports for different songs accumulate", () => {
  const merged = mergeSfaResearchContext(
    { featuring_tracks: ["Exhausting"] },
    { source: "spotify_for_artists_csv" },
    ["Exhausting", "Kompressa"],
  );
  assertEquals(merged.featuring_tracks, ["Exhausting", "Kompressa"]);
});

Deno.test("merge: no existing row → incoming context is used as-is", () => {
  const merged = mergeSfaResearchContext(null, { source: "spotify_for_artists_csv" }, ["Kompressa"]);
  assertEquals(merged.featuring_tracks, ["Kompressa"]);
});
