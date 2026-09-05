/**
 * Shared outreach decision — track-only pitch, exact identity (always enforced).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveTrackPitchCopy, resolveFitReason } from "./pitch-copy.ts";
import { validateMatchingExpression, profilesToSweepBuckets } from "./discovery-profiles.ts";
import { applyPitchTemplate, UnknownPitchPlaceholderError } from "./pitch-templates.ts";

Deno.test("MEDITATE-style rap DNA: house playlist lane is a contradiction", () => {
  const approved = new Set(["rap_general", "rap_trap_hype"]);
  const excluded = new Set(["house_club", "deep_house_groove", "house_general"]);
  const lane = "house_club";
  assertEquals(excluded.has(lane), true);
  assertEquals(approved.has(lane), false);
});

Deno.test("playlist/lane copy cannot populate {{pitch}} vars", () => {
  const pitch = resolveTrackPitchCopy({
    track: { short_pitch: "SONG PITCH", pitch_angle: null },
    approvedDna: null,
  });
  assertEquals(pitch.ok, true);
  if (pitch.ok) assertEquals(pitch.pitch, "SONG PITCH");

  const fit = resolveFitReason({
    row: { recommended_pitch_angle: "PLAYLIST REC", lane: "deep_house_groove" },
    lanes: { deep_house_groove: { pitch_angle: "LANE FALLBACK" } },
  });
  assertEquals(fit.fitReason, "PLAYLIST REC");
  assertEquals(fit.source, "playlist_targets.recommended_pitch_angle");
});

Deno.test("unknown template placeholders are rejected", () => {
  let threw = false;
  try {
    applyPitchTemplate("Hi {{unknown_token}}", "Body", {
      curator_name: "A",
      playlist_name: "P",
      track_name: "T",
      pitch: "pitch",
      stream_link: "",
      artist_name: "X",
      prior_track: "",
    });
  } catch (e) {
    threw = e instanceof UnknownPitchPlaceholderError;
  }
  assertEquals(threw, true);
});

Deno.test("{{fit_reason}} is rejected as an unknown placeholder", () => {
  let threw = false;
  try {
    applyPitchTemplate("Hi", "{{fit_reason}}", {
      curator_name: "A",
      playlist_name: "P",
      track_name: "T",
      pitch: "pitch",
      stream_link: "",
      artist_name: "X",
      prior_track: "",
    });
  } catch (e) {
    threw = e instanceof UnknownPitchPlaceholderError;
  }
  assertEquals(threw, true);
});

Deno.test("invalid matching_expression is rejected at validate time", () => {
  assertEquals(validateMatchingExpression("(unclosed") !== null, true);
  assertEquals(validateMatchingExpression("trap|drill"), null);
});

Deno.test("profilesToSweepBuckets builds rap/house terms without source literals", () => {
  const b = profilesToSweepBuckets([
    {
      id: "1",
      profile_key: "rap",
      label: "Rap",
      is_active: true,
      approval_status: "approved",
      genre_family: "rap",
      included_search_terms: ["trap", "drill"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: [],
      search_weight: 1,
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      matching_expression: null,
      allocation_share: 0.55,
    },
    {
      id: "2",
      profile_key: "house",
      label: "House",
      is_active: true,
      approval_status: "approved",
      genre_family: "house",
      included_search_terms: ["deep house", "tech house"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: [],
      search_weight: 1,
      approved_lanes: ["house_general"],
      excluded_lanes: [],
      matching_expression: null,
      allocation_share: 0.45,
    },
  ]);
  assertEquals(b.rapTerms.includes("trap"), true);
  assertEquals(b.houseTerms.includes("deep house"), true);
  assertEquals(Math.abs(b.rapShare - 0.55) < 0.01, true);
});

Deno.test("title-only / missing track pitch is a hard miss", () => {
  const pitch = resolveTrackPitchCopy({
    track: { short_pitch: null, pitch_angle: null },
    approvedDna: null,
  });
  assertEquals(pitch.ok, false);
});
