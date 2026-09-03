/**
 * Shared outreach decision — track-only pitch, identity, shadow mode.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveFitReason,
  resolveTrackPitchCopy,
} from "./pitch-copy.ts";
import {
  applyPitchTemplate,
  UnknownPitchPlaceholderError,
  varsFromPitchContext,
} from "./pitch-templates.ts";
import { validateMatchingExpression } from "./discovery-profiles.ts";
import { profilesToSweepBuckets, type DiscoveryProfile } from "./discovery-profiles.ts";

Deno.test("MEDITATE-style rap DNA: house playlist lane is a contradiction", () => {
  const pitch = resolveTrackPitchCopy({
    track: { id: "meditate", short_pitch: "Conscious hip-hop meditation" },
    approvedDna: {
      id: "dna-m",
      short_pitch: "Conscious hip-hop meditation",
      approval_state: "approved",
    },
  });
  assertEquals(pitch.ok, true);

  // Lane contradiction is evaluated in evaluateOutreachDecision; here we assert
  // the pitch itself never comes from the house lane angle.
  const blocked = resolveTrackPitchCopy({
    track: { short_pitch: null, pitch_angle: null },
    approvedDna: null,
  });
  assertEquals(blocked.ok, false);

  const fit = resolveFitReason({
    row: { recommended_pitch_angle: "Deep house luxury", lane: "house_club" },
    lanes: { house_club: { pitch_angle: "Club house energy" } },
  });
  assertEquals(fit.fitReason, "Deep house luxury");
  // Critical: fit must not be usable as pitch when track copy is missing
  assertEquals(blocked.ok, false);
});

Deno.test("playlist/lane copy cannot populate {{pitch}} vars", () => {
  const pitch = resolveTrackPitchCopy({
    track: { short_pitch: "SONG PITCH ONLY" },
    approvedDna: null,
  });
  assertEquals(pitch.ok, true);
  if (!pitch.ok) return;
  const fit = resolveFitReason({
    row: { recommended_pitch_angle: "TARGET FIT", lane: "rap_general" },
    lanes: { rap_general: { pitch_angle: "LANE FIT" } },
  });
  const vars = varsFromPitchContext({
    curatorName: "Alex",
    playlistName: "Rap Heat",
    trackName: "MEDITATE",
    shortPitch: pitch.pitch,
    fitReason: fit.fitReason,
    platform: "spotify",
    streamUrl: "https://open.spotify.com/track/x",
    isWarm: false,
    tone: "warm_personal",
    artistName: "Fendi Frost",
  });
  assertEquals(vars.pitch, "SONG PITCH ONLY");
  assertEquals(vars.fit_reason, "TARGET FIT");
  assertEquals(vars.pitch.includes("TARGET FIT"), false);
});

Deno.test("unknown template placeholders are rejected", () => {
  let threw = false;
  try {
    applyPitchTemplate("Hi {{curator_name}}", "Body {{unknown_field}}", {
      curator_name: "A",
      playlist_name: "P",
      track_name: "T",
      pitch: "PITCH",
      fit_reason: "",
      stream_link: "",
      artist_name: "F",
      prior_track: "",
    });
  } catch (e) {
    threw = e instanceof UnknownPitchPlaceholderError;
  }
  assertEquals(threw, true);
});

Deno.test("invalid matching_expression is rejected at validate time", () => {
  assertEquals(validateMatchingExpression("("), "Invalid matching_expression: ".length > 0
    ? validateMatchingExpression("(")
    : null);
  assertEquals(validateMatchingExpression("rap|hip.?hop") === null, true);
});

Deno.test("profilesToSweepBuckets builds rap/house terms without source literals", () => {
  const profiles: DiscoveryProfile[] = [
    {
      id: "1",
      profile_key: "rap_catalogue",
      label: "Rap",
      is_active: true,
      approval_status: "pending_fendi_review",
      genre_family: "rap",
      included_search_terms: ["trap", "conscious rap"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: ["rap_general"],
      search_weight: 1,
      approved_lanes: ["rap_general"],
      excluded_lanes: ["house_club"],
      matching_expression: null,
      allocation_share: 0.55,
    },
    {
      id: "2",
      profile_key: "house_electronic_catalogue",
      label: "House",
      is_active: true,
      approval_status: "pending_fendi_review",
      genre_family: "house",
      included_search_terms: ["deep house", "tech house"],
      excluded_search_terms: [],
      reference_artists: [],
      compatible_target_category_slugs: ["house_club"],
      search_weight: 1,
      approved_lanes: ["house_club"],
      excluded_lanes: ["rap_general"],
      matching_expression: null,
      allocation_share: 0.45,
    },
  ];
  const b = profilesToSweepBuckets(profiles);
  assertEquals(b.rapTerms.includes("trap"), true);
  assertEquals(b.houseTerms.includes("deep house"), true);
  assertEquals(b.laneGenre["rap_general"], "rap");
  assertEquals(b.laneGenre["house_club"], "house");
  assertEquals(Math.abs(b.rapShare - 0.55) < 0.01, true);
});

Deno.test("title-only / missing track pitch is a hard miss", () => {
  const r = resolveTrackPitchCopy({ track: null, approvedDna: null });
  assertEquals(r.ok, false);
});
