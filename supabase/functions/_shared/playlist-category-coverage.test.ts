import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarizeCategoryCoverage } from "./playlist-category-coverage.ts";

Deno.test("summarizeCategoryCoverage counts empty vs covered playlists", () => {
  const summary = summarizeCategoryCoverage(
    [
      {
        playlist_id: "p1",
        playlist_name: "Covered",
        curator_name: "A",
        platform: "spotify",
        is_active: true,
        playlist_categories: [{ category_id: "c1" }],
      },
      {
        playlist_id: "p2",
        playlist_name: "Missing",
        curator_name: "B",
        platform: "spotify",
        is_active: true,
        playlist_categories: [],
      },
      {
        playlist_id: "p3",
        playlist_name: "Also missing",
        curator_name: null,
        platform: "spotify",
        is_active: true,
        playlist_categories: null,
      },
    ],
    { sampleLimit: 10 },
  );

  assertEquals(summary.scanned, 3);
  assertEquals(summary.with_categories, 1);
  assertEquals(summary.without_categories, 2);
  assertEquals(summary.coverage_pct, 33.3);
  assertEquals(summary.sample_missing.map((r) => r.playlist_id), ["p2", "p3"]);
  assertEquals(summary.sample_covered.map((r) => r.playlist_id), ["p1"]);
});

Deno.test("summarizeCategoryCoverage returns zero coverage on empty pool", () => {
  const summary = summarizeCategoryCoverage([]);
  assertEquals(summary.scanned, 0);
  assertEquals(summary.coverage_pct, 0);
  assertEquals(summary.sample_missing.length, 0);
});
