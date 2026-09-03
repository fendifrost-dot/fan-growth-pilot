// Deno tests for pitch-copy resolution and DB-backed pitch templates.
// Run: deno test supabase/functions/_shared/pitch-copy.test.ts supabase/functions/_shared/pitch-templates.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { missingPitchCopyResult, resolvePitchAngle } from "./pitch-copy.ts";

const dummySb = {} as never;

Deno.test("resolvePitchAngle prefers tracks.short_pitch over every other source", () => {
  const r = resolvePitchAngle(dummySb, {
    track: { short_pitch: "TRACK SHORT PITCH", pitch_angle: "TRACK ANGLE" },
    row: { recommended_pitch_angle: "PLAYLIST ANGLE", lane: "rap_general" },
    lanes: { rap_general: { pitch_angle: "LANE ANGLE THAT MUST NOT WIN" } },
  });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.pitch, "TRACK SHORT PITCH");
    assertEquals(r.source, "tracks.short_pitch");
  }
});

Deno.test("resolvePitchAngle falls through short_pitch → pitch_angle → recommended → lane", () => {
  const laneOnly = resolvePitchAngle(dummySb, {
    track: { short_pitch: "  ", pitch_angle: null },
    row: { recommended_pitch_angle: "", lane: "deep_house_groove" },
    lanes: { deep_house_groove: { pitch_angle: "LANE FALLBACK" } },
  });
  assertEquals(laneOnly.ok, true);
  if (laneOnly.ok) {
    assertEquals(laneOnly.pitch, "LANE FALLBACK");
    assertEquals(laneOnly.source, "artist_config.lanes.pitch_angle");
  }

  const rec = resolvePitchAngle(dummySb, {
    track: { short_pitch: null, pitch_angle: "  " },
    row: { recommended_pitch_angle: "PLAYLIST REC", lane: "deep_house_groove" },
    lanes: { deep_house_groove: { pitch_angle: "LANE FALLBACK" } },
  });
  assertEquals(rec.ok, true);
  if (rec.ok) assertEquals(rec.pitch, "PLAYLIST REC");

  const trackAngle = resolvePitchAngle(dummySb, {
    track: { short_pitch: null, pitch_angle: "TRACK ANGLE" },
    row: { recommended_pitch_angle: "PLAYLIST REC", lane: "deep_house_groove" },
    lanes: { deep_house_groove: { pitch_angle: "LANE FALLBACK" } },
  });
  assertEquals(trackAngle.ok, true);
  if (trackAngle.ok) {
    assertEquals(trackAngle.pitch, "TRACK ANGLE");
    assertEquals(trackAngle.source, "tracks.pitch_angle");
  }
});

Deno.test("resolvePitchAngle is missing when every source is empty — no invented copy", () => {
  const r = resolvePitchAngle(dummySb, {
    track: { short_pitch: null, pitch_angle: "" },
    row: { recommended_pitch_angle: null, lane: "rap_general" },
    lanes: { rap_general: { label: "Rap" } },
  });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.pitch, null);
    assertEquals(r.missing.includes("tracks.short_pitch"), true);
  }
});

Deno.test("missingPitchCopyResult is a 422 and names Admin → Songs as the remedy", () => {
  const res = missingPitchCopyResult({
    trackName: "Example",
    trackId: "t1",
    playlistId: "spotify:abc",
    lane: "rap_general",
  });
  assertEquals(res.status, 422);
  assertEquals(res.data.error, "No pitch copy configured");
  assertEquals(res.data.remedy, "Set a short pitch for this track in Admin → Songs.");
  assertEquals(res.data.track_name, "Example");
  assertEquals(res.data.playlist_id, "spotify:abc");
});
