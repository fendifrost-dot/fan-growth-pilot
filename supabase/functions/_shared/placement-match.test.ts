// Deno tests for the placement-match helpers powering recommend_targets_for_track.
// Run: deno test supabase/functions/_shared/placement-match.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SFA_PLACEHOLDER_TRACK,
  normalizeTrackName,
  featuringTrackNames,
  placementMatch,
  compareTargets,
  categoryGate,
  categoryOverlapCount,
  trackGenre,
  targetGenre,
} from "./placement-match.ts";

const rowWith = (featuring: unknown) => ({ research_context: { featuring_tracks: featuring } });

Deno.test("normalizeTrackName lowercases, trims, collapses whitespace", () => {
  assertEquals(normalizeTrackName("  Choose  My   Enemies WISELY "), "choose my enemies wisely");
  assertEquals(normalizeTrackName(null), "");
  assertEquals(normalizeTrackName(undefined), "");
});

Deno.test("placementMatch: exact match", () => {
  const r = rowWith(["Exhausting"]);
  const m = placementMatch(r, "Exhausting");
  assertEquals(m.matched, true);
  assertEquals(m.matchedName, "Exhausting");
});

Deno.test("placementMatch: case + whitespace mismatch still matches (the real SFA case)", () => {
  // Placement stored as CHOOSE MY ENEMIES WISELY; tracks row is Choose My Enemies Wisely.
  const r = rowWith(["CHOOSE MY ENEMIES WISELY"]);
  const m = placementMatch(r, "  Choose My Enemies Wisely ");
  assertEquals(m.matched, true);
  assertEquals(m.matchedName, "CHOOSE MY ENEMIES WISELY");
});

Deno.test("placementMatch: the SFA placeholder never counts as a placement", () => {
  const r = rowWith([SFA_PLACEHOLDER_TRACK]);
  assertEquals(featuringTrackNames(r), []);
  // Even asking for the placeholder string itself must not match.
  assertEquals(placementMatch(r, SFA_PLACEHOLDER_TRACK).matched, false);
  assertEquals(placementMatch(r, "Exhausting").matched, false);
});

Deno.test("placementMatch: no research_context / empty array → no match", () => {
  assertEquals(placementMatch({}, "Exhausting").matched, false);
  assertEquals(placementMatch(rowWith([]), "Exhausting").matched, false);
  assertEquals(placementMatch(rowWith(["", "  "]), "Exhausting").matched, false);
  assertEquals(placementMatch(rowWith(["Exhausting"]), "").matched, false);
});

Deno.test("placementMatch: finds the target among multiple featuring tracks", () => {
  const r = rowWith([SFA_PLACEHOLDER_TRACK, "Some Other Song", "exhausting"]);
  const m = placementMatch(r, "Exhausting");
  assertEquals(m.matched, true);
  assertEquals(m.matchedName, "exhausting");
});

Deno.test("compareTargets: direct placement outranks category overlap, tier, followers", () => {
  // Row with categories but NO placement.
  const categoryOnly = { placement: false, overlap: 3, tier: 1, followers: 100000 };
  // Row with a placement but weaker on every secondary signal.
  const placementOnly = { placement: true, overlap: 0, tier: 9, followers: 10 };
  assertEquals(compareTargets(placementOnly, categoryOnly) < 0, true);
  assertEquals([categoryOnly, placementOnly].sort(compareTargets)[0], placementOnly);
});

Deno.test("compareTargets: a row with both placement and overlap ranks first", () => {
  const both = { placement: true, overlap: 5, tier: 1, followers: 500 };
  const placementNoOverlap = { placement: true, overlap: 0, tier: 1, followers: 500 };
  const overlapNoPlacement = { placement: false, overlap: 5, tier: 1, followers: 500 };
  const ranked = [overlapNoPlacement, placementNoOverlap, both].sort(compareTargets);
  assertEquals(ranked[0], both);
  assertEquals(ranked[1], placementNoOverlap);
  assertEquals(ranked[2], overlapNoPlacement);
});

Deno.test("compareTargets: within same placement/overlap, lower tier then higher followers wins", () => {
  const tier1 = { placement: false, overlap: 2, tier: 1, followers: 10 };
  const tier2 = { placement: false, overlap: 2, tier: 2, followers: 999 };
  assertEquals(compareTargets(tier1, tier2) < 0, true);
  const moreFollowers = { placement: false, overlap: 2, tier: 1, followers: 5000 };
  const fewerFollowers = { placement: false, overlap: 2, tier: 1, followers: 50 };
  assertEquals(compareTargets(moreFollowers, fewerFollowers) < 0, true);
});

// --- category gate --------------------------------------------------------
// Regression cover for the live outage: an empty playlist_categories across the
// verified pool rejected 27/31 deep-house targets for "Designed For Me (Control)"
// and 100% of targets for "Meditate" with "Category mismatch".

// AGH P0-A SPLIT the fail-open above by which side is silent. A silent TARGET
// still passes (that is the DFM unblock); a silent TRACK no longer does, because
// "we know nothing about this song" is a reason to hold, not to send.

Deno.test("categoryGate: empty-vs-empty is now needs_song_intelligence, not a pass", () => {
  // Was the outage fix's headline pass. After the P0-A split the SONG side is
  // silent here too, so it fails closed — the target-silent unblock is asserted
  // separately below and is unaffected.
  const g = categoryGate({ trackCatIds: [], targetCatIds: [], trackGenre: null, targetGenre: null });
  assertEquals(g.pass, false);
  assertEquals(g.reason, "needs_song_intelligence");
});

Deno.test("categoryGate: target with NO category still passes on genre agreement", () => {
  // The 27 rejected DFM targets: genre-correct house rows, empty category column.
  const g = categoryGate({
    trackCatIds: ["cat-house"], targetCatIds: [], trackGenre: "house", targetGenre: "house",
  });
  assertEquals(g.pass, true);
  assertEquals(g.reason, "genre_match");
});

Deno.test("categoryGate: track with no category at all is BLOCKED (the AGH-001 Meditate case)", () => {
  // The regression this gate exists for. Previously passed with
  // "no_category_signal" against a fully categorised target, which is how a song
  // we knew nothing about got as far as the send path.
  const g = categoryGate({
    trackCatIds: [], targetCatIds: ["cat-house"], trackGenre: null, targetGenre: "house",
  });
  assertEquals(g.pass, false);
  assertEquals(g.reason, "needs_song_intelligence");
});

Deno.test("categoryGate: TARGET-silent still passes — the DFM unblock must not regress", () => {
  // The 27 rejected DFM targets: song side known (house), target side silent on
  // both the category column and any genre signal. This is the case the fail-open
  // was written for and the split deliberately preserves it.
  const g = categoryGate({
    trackCatIds: ["cat-house"], targetCatIds: [], trackGenre: "house", targetGenre: null,
  });
  assertEquals(g.pass, true);
  assertEquals(g.reason, "no_category_signal");
});

Deno.test("categoryGate: track silence outranks target silence", () => {
  // Both silent -> answer with the song-side (stricter) reason, never the
  // target-side pass. Guards the ordering of the two branches.
  const g = categoryGate({
    trackCatIds: [], targetCatIds: [], trackGenre: null, targetGenre: null,
  });
  assertEquals(g.pass, false);
  assertEquals(g.reason, "needs_song_intelligence");
});

Deno.test("categoryGate: explicit overlap short-circuits to a pass", () => {
  const g = categoryGate({
    trackCatIds: ["a", "b"], targetCatIds: ["b"], trackGenre: "house", targetGenre: "rap",
  });
  assertEquals(g.pass, true);
  assertEquals(g.reason, "category_overlap");
});

Deno.test("categoryGate: a REAL genre conflict is still rejected", () => {
  const g = categoryGate({
    trackCatIds: ["cat-rap"], targetCatIds: ["cat-house"], trackGenre: "rap", targetGenre: "house",
  });
  assertEquals(g.pass, false);
  assertEquals(g.reason, "genre_conflict");
});

Deno.test("categoryGate: no overlap but agreeing genres passes", () => {
  const g = categoryGate({
    trackCatIds: ["deep-house"], targetCatIds: ["tech-house"], trackGenre: "house", targetGenre: "house",
  });
  assertEquals(g.pass, true);
  assertEquals(g.reason, "genre_match");
});

Deno.test("categoryOverlapCount counts shared ids", () => {
  assertEquals(categoryOverlapCount(["a", "b", "c"], ["b", "c", "d"]), 2);
  assertEquals(categoryOverlapCount([], ["a"]), 0);
});

Deno.test("targetGenre reads the stamped sweep lane first", () => {
  assertEquals(targetGenre({ lane: "house_club", playlist_name: "Untitled" }), "house");
  assertEquals(targetGenre({ lane: "rap_trap_hype", playlist_name: "Untitled" }), "rap");
});

Deno.test("targetGenre falls back to the row's own text when lane is absent", () => {
  assertEquals(targetGenre({ playlist_name: "Deep House Grooves" }), "house");
  assertEquals(targetGenre({ playlist_name: "Trap Nation", curator_name: "" }), "rap");
  // No signal must stay null, not become a guess.
  assertEquals(targetGenre({ playlist_name: "Chill Vibes" }), null);
});

Deno.test("trackGenre: Meditate is a CLUB record despite the name", () => {
  // Named like a meditation track; the category/copy is what decides.
  assertEquals(
    trackGenre({ name: "Meditate", categories: [{ slug: "house-club", label: "House / Club" }] }),
    "house",
  );
});

Deno.test("trackGenre falls back to short_pitch copy when uncategorised", () => {
  assertEquals(trackGenre({ name: "Meditate", short_pitch: "A late-night house club cut." }), "house");
  assertEquals(trackGenre({ name: "Some Song" }), null);
});
