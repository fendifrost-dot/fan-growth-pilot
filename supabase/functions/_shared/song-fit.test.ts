import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideLaneFit, fitRejectionConflict, isFitRejectionReason, SONG_FIT_POLICY_VERSION } from "./song-fit.ts";

// Live approved DNA shapes (get_playlist_discovery_work, 2026-09-28) — fixtures, not enforcement data.
const MEDITATE = {
  id: "dna-meditate",
  primary_genre: "hip_hop_rap",
  approved_lanes: ["rap_general", "rap_trap_hype", "rap_conscious", "west_coast_conscious"],
  excluded_lanes: ["house_club", "deep_house_groove"],
};
const DFM = {
  id: "dna-dfm",
  primary_genre: "house_electronic",
  approved_lanes: ["deep_house_groove", "house_general", "house_club", "rap_general"],
  excluded_lanes: ["rap_trap_hype", "rap_conscious", "west_coast_conscious"],
};

Deno.test("song fit: a narrower rap lane fits a hip_hop_rap song when its DNA approves the lane", () => {
  for (const lane of ["rap_trap_hype", "rap_conscious", "rap_general"]) {
    const d = decideLaneFit(MEDITATE, lane);
    assertEquals(d.fit, true, lane);
    assertEquals(d.code, "lane_approved");
    assertEquals(d.song_dna_version_id, "dna-meditate");
    assertEquals(d.policy_version, SONG_FIT_POLICY_VERSION);
    assert(d.primary_genre_note.includes("broad genre family"));
  }
});

Deno.test("song fit: stays song-specific — DFM excludes the rap lanes Meditate allows", () => {
  assertEquals(decideLaneFit(DFM, "rap_trap_hype").code, "lane_excluded");
  assertEquals(decideLaneFit(DFM, "rap_general").fit, true);
  assertEquals(decideLaneFit(MEDITATE, "house_club").code, "lane_excluded");
  assertEquals(decideLaneFit(MEDITATE, "nu_disco").code, "lane_not_in_approved_dna");
  assertEquals(decideLaneFit(MEDITATE, null).code, "lane_missing");
  assertEquals(decideLaneFit(null, "rap_general").code, "dna_unavailable");
  assertEquals(decideLaneFit(MEDITATE, "RAP_TRAP_HYPE").fit, true); // case-insensitive
});

Deno.test("song fit: Grok's 'DNA_LANE_MISMATCH Meditate hip_hop_rap only' conflicts with the approved DNA", () => {
  assert(isFitRejectionReason("DNA_LANE_MISMATCH Meditate hip_hop_rap only"));
  assert(isFitRejectionReason(null, "lane mismatch"));
  assert(!isFitRejectionReason("LOW_REACH", "german-language remit"));
  const conflict = fitRejectionConflict(decideLaneFit(MEDITATE, "rap_trap_hype"), "DNA_LANE_MISMATCH", "Meditate hip_hop_rap only");
  assertEquals(conflict?.code, "fit_decision_conflict");
  // A genuinely off-DNA lane: the fit rejection stands.
  assertEquals(fitRejectionConflict(decideLaneFit(MEDITATE, "house_club"), "DNA_LANE_MISMATCH", null), null);
  // Non-fit reasons are never blocked.
  assertEquals(fitRejectionConflict(decideLaneFit(MEDITATE, "rap_trap_hype"), "LANGUAGE_MISMATCH", "German-language remit"), null);
});
