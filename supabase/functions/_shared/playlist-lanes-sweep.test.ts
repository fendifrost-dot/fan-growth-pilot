import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isLaneGenreMismatch,
  isSweepLane,
  rowMatchesLane,
  setSweepLaneRoutingFromProfiles,
  SWEEP_LANE_GENRE,
  sweepLaneTextGenre,
} from "./playlist-lanes.ts";

// Populate routing from discovery-profile-shaped data (not source literals at
// module load). Mirrors what loadActiveDiscoveryProfiles → profilesToSweepBuckets does.
setSweepLaneRoutingFromProfiles({
  rap_trap_hype: "rap",
  rap_conscious: "rap",
  rap_general: "rap",
  house_club: "house",
  house_general: "house",
});

Deno.test("isSweepLane recognizes lanes provided by discovery profiles", () => {
  for (const l of Object.keys(SWEEP_LANE_GENRE)) assertEquals(isSweepLane(l), true);
  assertEquals(isSweepLane("deep_house_groove"), false);
  assertEquals(isSweepLane(""), false);
});

Deno.test("sweepLaneTextGenre reads rap vs house, null when ambiguous/none", () => {
  assertEquals(sweepLaneTextGenre("Underground Trap Bangers"), "rap");
  assertEquals(sweepLaneTextGenre("Soulful Deep House"), "house");
  assertEquals(sweepLaneTextGenre("Chill Weekend Vibes"), null);
  assertEquals(sweepLaneTextGenre("Rap x House Crossover"), null);
});

Deno.test("rowMatchesLane: a rap sweep lane MATCHES a rap-named row (reconcile keeps it)", () => {
  const row = { playlist_name: "Best Underground Rap 2026", curator_name: "cratedigger", vibe_tags: [] };
  assertEquals(rowMatchesLane(row, "rap_trap_hype", null, []), true);
});

Deno.test("rowMatchesLane: a rap sweep lane on a HOUSE-named row does NOT match (reconcile flags it)", () => {
  const row = { playlist_name: "Deep House Grooves", curator_name: "housecat", vibe_tags: [] };
  assertEquals(rowMatchesLane(row, "rap_general", null, []), false);
});

Deno.test("rowMatchesLane: an ambiguous-name sweep-lane row still matches (assigned from richer evidence)", () => {
  const row = { playlist_name: "Late Night Selects", curator_name: "dj", vibe_tags: [] };
  assertEquals(rowMatchesLane(row, "rap_general", null, []), true);
  assertEquals(rowMatchesLane(row, "house_general", null, []), true);
});

Deno.test("isLaneGenreMismatch: opposite-genre name flags a sweep lane, ambiguous does not", () => {
  assertEquals(isLaneGenreMismatch("rap_general", "Deep House Top 50", null), true);
  assertEquals(isLaneGenreMismatch("house_general", "Hardest Trap & Drill", null), true);
  assertEquals(isLaneGenreMismatch("rap_general", "Fresh Rap Heat", null), false);
  assertEquals(isLaneGenreMismatch("rap_general", "Weekend Selects", null), false);
});
