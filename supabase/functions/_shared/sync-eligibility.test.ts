import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TRACK_IDS, evaluateSyncReady } from "./catalog-rules.ts";

Deno.test("evaluateSyncReady refuses sample-only clearance", () => {
  const r = evaluateSyncReady({
    hasSample: "no",
    approvedDnaVersionId: null,
    sampleDeclarationApproved: false,
    syncApprovedByFendi: false,
    splitsReady: false,
    publishingReady: false,
    assetsReady: false,
  });
  assertEquals(r.ready, false);
  assertEquals(r.blockers.includes("approved_song_dna"), true);
  assertEquals(r.blockers.includes("fendi_sync_approval"), true);
});

Deno.test("Neva requires private_license_evidence even when other gates are green", () => {
  const almost = {
    hasSample: "no",
    approvedDnaVersionId: "dna-1",
    sampleDeclarationApproved: true,
    syncApprovedByFendi: true,
    splitsReady: true,
    publishingReady: true,
    assetsReady: true,
    unresolvedRightsException: false,
    sampleExceptionResolved: false,
    privateLicenseRequired: true,
    privateLicenseOnFile: false,
  };
  const blocked = evaluateSyncReady(almost);
  assertEquals(blocked.ready, false);
  assertEquals(blocked.blockers.includes("private_license_evidence"), true);

  const ok = evaluateSyncReady({ ...almost, privateLicenseOnFile: true });
  assertEquals(ok.ready, true);
  assertEquals(ok.blockers.length, 0);
});

Deno.test("TRACK_IDS.NEVA_TOO_MUCH_PRADA is stable", () => {
  assertEquals(TRACK_IDS.NEVA_TOO_MUCH_PRADA.length, 36);
  assertEquals(TRACK_IDS.NEVA_TOO_MUCH_PRADA.includes("-"), true);
});
