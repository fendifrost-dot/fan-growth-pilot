// Deno tests for the placement-match helpers powering recommend_targets_for_track.
// Run: deno test supabase/functions/_shared/placement-match.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SFA_PLACEHOLDER_TRACK,
  normalizeTrackName,
  featuringTrackNames,
  placementMatch,
  compareTargets,
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
