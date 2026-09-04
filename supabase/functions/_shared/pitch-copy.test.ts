// Deno tests: track-only {{pitch}}; lane/playlist copy never fills pitch.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  missingPitchCopyResult,
  resolveFitReason,
  resolvePitchAngle,
  resolveTrackPitchCopy,
} from "./pitch-copy.ts";

const dummySb = {} as never;

Deno.test("resolveTrackPitchCopy prefers approved DNA short_pitch", () => {
  const r = resolveTrackPitchCopy({
    track: { short_pitch: "TRACK SHORT", pitch_angle: "TRACK ANGLE" },
    approvedDna: {
      id: "dna-1",
      short_pitch: "DNA APPROVED PITCH",
      approval_state: "approved",
    },
  });
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.pitch, "DNA APPROVED PITCH");
    assertEquals(r.source, "song_dna_versions.short_pitch");
    assertEquals(r.songDnaVersionId, "dna-1");
  }
});

Deno.test("resolvePitchAngle ignores playlist and lane copy for {{pitch}}", () => {
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

Deno.test("lane/playlist fallback cannot populate {{pitch}} — 422 path", () => {
  const r = resolvePitchAngle(dummySb, {
    track: { short_pitch: "  ", pitch_angle: null },
    row: { recommended_pitch_angle: "PLAYLIST REC", lane: "deep_house_groove" },
    lanes: { deep_house_groove: { pitch_angle: "LANE FALLBACK" } },
  });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.pitch, null);
    assertEquals(r.missing.includes("tracks.short_pitch"), true);
  }
});

Deno.test("resolveFitReason uses playlist/lane copy as {{fit_reason}} only", () => {
  const fit = resolveFitReason({
    row: { recommended_pitch_angle: "PLAYLIST FIT", lane: "rap_general" },
    lanes: { rap_general: { pitch_angle: "LANE FIT" } },
  });
  assertEquals(fit.fitReason, "PLAYLIST FIT");
  assertEquals(fit.source, "playlist_targets.recommended_pitch_angle");
});

Deno.test("missingPitchCopyResult names Song DNA remedy and track fields", () => {
  const res = missingPitchCopyResult({
    trackName: "MEDITATE",
    trackId: "t1",
    playlistId: "spotify:abc",
    lane: "house_club",
  });
  assertEquals(res.status, 422);
  assertEquals(res.data.error, "No pitch copy configured");
  assertEquals(String(res.data.remedy).includes("{{pitch}}"), true);
  assertEquals(res.data.track_id, "t1");
});
