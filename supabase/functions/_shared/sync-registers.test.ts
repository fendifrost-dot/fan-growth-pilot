import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertGenreStampAllowed,
  computeSyncEligible,
  parseAggregator,
  patchForLicensingResponse,
  trackSyncFields,
} from "./sync-registers.ts";
import {
  TRACK_IDS,
  isMeditateTrackId,
  assertHouseElectronicStampAllowed,
} from "./catalog-rules.ts";

Deno.test("Meditate track id is recognized and cannot take house stamp", () => {
  assertEquals(isMeditateTrackId(TRACK_IDS.MEDITATE), true);
  assertEquals(
    assertHouseElectronicStampAllowed(TRACK_IDS.MEDITATE, "house_electronic").ok,
    false,
  );
  assertEquals(
    assertHouseElectronicStampAllowed(TRACK_IDS.CONTROL, "house_electronic").ok,
    true,
  );
  assertEquals(
    assertHouseElectronicStampAllowed(TRACK_IDS.NEVA_TOO_MUCH_PRADA, "house_electronic").ok,
    false,
  );
});

Deno.test("house stamp blocked when rap DNA / current stamp contradicts", () => {
  assertEquals(
    assertGenreStampAllowed({
      genreStamp: "house_electronic",
      currentStamp: "hip_hop_rap",
    }).ok,
    false,
  );
  assertEquals(
    assertGenreStampAllowed({
      genreStamp: "house_electronic",
      approvedPrimaryGenre: "Hip-Hop/Rap",
    }).ok,
    false,
  );
  assertEquals(assertGenreStampAllowed({ genreStamp: "house_electronic" }).ok, true);
  assertEquals(assertGenreStampAllowed({ genreStamp: "hip_hop_rap" }).ok, true);
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

Deno.test("trackSyncFields rejects house stamp when rap identity contradicts", () => {
  const bad = trackSyncFields(
    { genre_stamp: "house_electronic" },
    { currentStamp: "hip_hop_rap" },
  );
  assertEquals("error" in bad, true);
  const ok = trackSyncFields(
    { genre_stamp: "hip_hop_rap", has_sample: "no" },
    { currentStamp: null },
  );
  assertEquals("error" in ok, false);
  if (!("error" in ok)) {
    assertEquals(ok.genre_stamp, "hip_hop_rap");
    assertEquals(ok.has_sample, "no");
  }
});

Deno.test("trackSyncFields refuses writable sync_eligible", () => {
  const bad = trackSyncFields({ sync_eligible: true });
  assertEquals("error" in bad, true);
});

Deno.test("licensing response patch mirrors playlist pitch_log", () => {
  assertEquals(patchForLicensingResponse("licensed").placed, true);
  assertEquals(patchForLicensingResponse("declined").reply_received, true);
  assertEquals(patchForLicensingResponse("awaiting").reply_received, false);
});
