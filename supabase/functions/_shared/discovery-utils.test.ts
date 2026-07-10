import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDiscoveryQueries,
  computeRotation,
  dedupeStubs,
  extractPlaylistIdsFromText,
  mapPool,
} from "./discovery-utils.ts";

Deno.test("mapPool preserves input order regardless of completion order", async () => {
  const items = [50, 10, 30, 5, 20];
  const out = await mapPool(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 2;
  });
  assertEquals(out, [100, 20, 60, 10, 40]);
});

Deno.test("mapPool never exceeds the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  });
  assertEquals(peak <= 4, true, `peak concurrency ${peak} exceeded cap 4`);
});

Deno.test("mapPool is faster than sequential (concurrency actually overlaps)", async () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  const start = Date.now();
  await mapPool(items, 4, async () => {
    await new Promise((r) => setTimeout(r, 25));
    return null;
  });
  const elapsed = Date.now() - start;
  // 8 tasks × 25ms = 200ms sequential; at concurrency 4 it should be ~50ms.
  // Generous ceiling to avoid CI flakiness, but well under the 200ms serial floor.
  assertEquals(elapsed < 150, true, `expected overlap, took ${elapsed}ms`);
});

Deno.test("mapPool stops launching new work once shouldStop trips", async () => {
  let launched = 0;
  let stop = false;
  const out = await mapPool(
    Array.from({ length: 20 }, (_, i) => i),
    2,
    async (i) => {
      launched++;
      if (i >= 3) stop = true; // trip the deadline after a few
      await new Promise((r) => setTimeout(r, 1));
      return i;
    },
    () => stop,
  );
  assertEquals(launched < 20, true, `expected early stop, launched ${launched}`);
  assertEquals(out.length, 20); // array shape preserved; tail is undefined
});

Deno.test("dedupeStubs filters already-seen and recently-pitched ids", () => {
  const seen = new Set<string>();
  const excludeIds = new Set<string>(["spotify:pitchedAAAAAAAAAAAAAAAAA"]);
  const stubs = [
    { playlist_id: "freshOne1111111111111" },
    { playlist_id: "pitchedAAAAAAAAAAAAAAAAA" }, // excluded (recently pitched)
    { playlist_id: "freshOne1111111111111" }, // dup within run
    { playlist_id: "freshTwo2222222222222" },
    { playlist_id: null }, // ignored
  ];
  const { freshIds, skippedRecent } = dedupeStubs(stubs, seen, excludeIds);
  assertEquals(freshIds, ["spotify:freshOne1111111111111", "spotify:freshTwo2222222222222"]);
  assertEquals(skippedRecent, 1);
});

Deno.test("dedupeStubs threads `seen` across multiple calls", () => {
  const seen = new Set<string>();
  const exclude = new Set<string>();
  const a = dedupeStubs([{ playlist_id: "aaa" }, { playlist_id: "bbb" }], seen, exclude);
  const b = dedupeStubs([{ playlist_id: "bbb" }, { playlist_id: "ccc" }], seen, exclude);
  assertEquals(a.freshIds, ["spotify:aaa", "spotify:bbb"]);
  assertEquals(b.freshIds, ["spotify:ccc"]); // bbb already seen in call a
});

Deno.test("computeRotation advances as a lane accumulates discoveries", () => {
  const now = 1_750_000_000_000; // fixed timestamp (no Date.now in test)
  const r0 = computeRotation(now, 0);
  const r1 = computeRotation(now, 1);
  const r10 = computeRotation(now, 10);
  assertEquals(r1, r0 + 1);
  assertEquals(r10, r0 + 10);
});

Deno.test("buildDiscoveryQueries respects cap and rotates seeds", () => {
  const refs = ["Kaytranada", "Channel Tres"];
  const q0 = buildDiscoveryQueries(refs, "deep_house_groove", 12, 0);
  const q1 = buildDiscoveryQueries(refs, "deep_house_groove", 12, 1);
  assertEquals(q0.length, 12);
  assertEquals(q1.length, 12);
  // Rotation shifts the leading query, so two runs probe different facets.
  assertEquals(q0[0] !== q1[0], true, "rotation did not change the query set");
  // No duplicates within a set.
  assertEquals(new Set(q0).size, q0.length);
});

Deno.test("extractPlaylistIdsFromText harvests ids, dedupes, drops editorial", () => {
  const blob = [
    "https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd editorial — dropped",
    "Check out https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n now",
    "dup https://open.spotify.com/playlist/3cEYpjA9oz9GiPac4AsH4n again",
    "and open.spotify.com/playlist/2v3iNvzV7yBmnUN6D8ftgg?si=abc trailing query",
    "not a playlist https://open.spotify.com/track/1abcAABBCCDDEEFFGGHHIIz",
  ].join("\n");
  assertEquals(extractPlaylistIdsFromText(blob), [
    "3cEYpjA9oz9GiPac4AsH4n",
    "2v3iNvzV7yBmnUN6D8ftgg",
  ]);
});

Deno.test("extractPlaylistIdsFromText returns empty for text with no playlists", () => {
  assertEquals(extractPlaylistIdsFromText("nothing to see here"), []);
});

Deno.test("buildDiscoveryQueries works with only a lane (no references)", () => {
  const q = buildDiscoveryQueries([], "indie_pop", 5, 0);
  assertEquals(q.length, 5);
  assertEquals(q.every((s) => s.startsWith("indie pop ")), true);
});
