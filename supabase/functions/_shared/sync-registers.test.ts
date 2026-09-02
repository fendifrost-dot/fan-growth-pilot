import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertGenreStampAllowed,
  computeSyncEligible,
  isMeditateTitle,
  parseAggregator,
  patchForLicensingResponse,
  trackSyncFields,
} from "./sync-registers.ts";

Deno.test("Meditate cannot be stamped house", () => {
  assertEquals(isMeditateTitle("Meditate"), true);
  assertEquals(assertGenreStampAllowed("Meditate", "house_electronic").ok, false);
  assertEquals(assertGenreStampAllowed("Meditate", "hip_hop_rap").ok, true);
});

Deno.test("sync_eligible only when has_sample is no", () => {
  assertEquals(computeSyncEligible("no"), true);
  assertEquals(computeSyncEligible("yes"), false);
  assertEquals(computeSyncEligible("unknown"), false);
});

Deno.test("unknown aggregator is OPEN, not unreleased", () => {
  assertEquals(parseAggregator("DistroKid"), "distrokid");
  assertEquals(parseAggregator("tbd"), "open");
});

Deno.test("trackSyncFields rejects a house stamp on Meditate", () => {
  const bad = trackSyncFields({ genre_stamp: "house_electronic" }, "Meditate");
  assertEquals("error" in bad, true);
  const ok = trackSyncFields({ genre_stamp: "hip_hop_rap", has_sample: "no" }, "Meditate");
  assertEquals("error" in ok, false);
  if (!("error" in ok)) {
    assertEquals(ok.genre_stamp, "hip_hop_rap");
    assertEquals(ok.has_sample, "no");
  }
});

Deno.test("licensing response patch mirrors playlist pitch_log", () => {
  assertEquals(patchForLicensingResponse("licensed").placed, true);
  assertEquals(patchForLicensingResponse("declined").reply_received, true);
  assertEquals(patchForLicensingResponse("awaiting").reply_received, false);
});
