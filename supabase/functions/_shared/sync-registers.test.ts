import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertGenreStampAllowed,
  computeSyncEligible,
  isMeditateTitle,
  parseAggregator,
  patchForLicensingResponse,
  trackSyncFields,
} from "./sync-registers.ts";
import { TRACK_IDS } from "./catalog-rules.ts";

Deno.test("Meditate cannot be stamped house by UUID", () => {
  assertEquals(isMeditateTitle("Meditate"), true);
  assertEquals(assertGenreStampAllowed("Meditate", "house_electronic", TRACK_IDS.MEDITATE).ok, false);
  assertEquals(assertGenreStampAllowed("Meditate", "hip_hop_rap", TRACK_IDS.MEDITATE).ok, true);
});

Deno.test("house stamp requires allow-listed track_id", () => {
  assertEquals(assertGenreStampAllowed("Designed For Me (Control)", "house_electronic").ok, false);
  assertEquals(assertGenreStampAllowed("x", "house_electronic", TRACK_IDS.CONTROL).ok, true);
  assertEquals(assertGenreStampAllowed("x", "house_electronic", TRACK_IDS.NEVA_TOO_MUCH_PRADA).ok, false);
});

Deno.test("has_sample=no does not make sync_eligible", () => {
  assertEquals(computeSyncEligible("no"), false);
  assertEquals(computeSyncEligible("yes"), false);
  assertEquals(computeSyncEligible("unknown"), false);
});

Deno.test("unknown aggregator is OPEN, not unreleased", () => {
  assertEquals(parseAggregator("DistroKid"), "distrokid");
  assertEquals(parseAggregator("tbd"), "open");
});

Deno.test("trackSyncFields rejects a house stamp without allow-listed track_id", () => {
  const bad = trackSyncFields({ genre_stamp: "house_electronic" }, "Meditate", TRACK_IDS.MEDITATE);
  assertEquals("error" in bad, true);
  const ok = trackSyncFields({ genre_stamp: "hip_hop_rap", has_sample: "no" }, "Meditate", TRACK_IDS.MEDITATE);
  assertEquals("error" in ok, false);
  if (!("error" in ok)) {
    assertEquals(ok.genre_stamp, "hip_hop_rap");
    assertEquals(ok.has_sample, "no");
  }
});

Deno.test("trackSyncFields refuses writable sync_eligible", () => {
  const bad = trackSyncFields({ sync_eligible: true }, "Meditate", TRACK_IDS.MEDITATE);
  assertEquals("error" in bad, true);
});

Deno.test("licensing response patch mirrors playlist pitch_log", () => {
  assertEquals(patchForLicensingResponse("licensed").placed, true);
  assertEquals(patchForLicensingResponse("declined").reply_received, true);
  assertEquals(patchForLicensingResponse("awaiting").reply_received, false);
});
