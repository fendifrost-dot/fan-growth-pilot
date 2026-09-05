import { describe, it, expect } from "vitest";
import {
  TRACK_IDS,
  assertHouseElectronicStampAllowed,
  computeSyncEligible,
  evaluateSyncReady,
  isHouseElectronicTrackId,
  isMeditateTrackId,
} from "@/lib/catalogRules";

describe("House allow-list (track UUID write boundary)", () => {
  it("allows only the three locked House track IDs", () => {
    expect(isHouseElectronicTrackId(TRACK_IDS.BALENCIAGA)).toBe(true);
    expect(isHouseElectronicTrackId(TRACK_IDS.ELECTRILLA)).toBe(true);
    expect(isHouseElectronicTrackId(TRACK_IDS.CONTROL)).toBe(true);
    expect(isHouseElectronicTrackId(TRACK_IDS.MEDITATE)).toBe(false);
    expect(isHouseElectronicTrackId(TRACK_IDS.NEVA_TOO_MUCH_PRADA)).toBe(false);
  });

  it("blocks MEDITATE from house_electronic by UUID", () => {
    expect(isMeditateTrackId(TRACK_IDS.MEDITATE)).toBe(true);
    const r = assertHouseElectronicStampAllowed(TRACK_IDS.MEDITATE, "house_electronic");
    expect(r.ok).toBe(false);
  });

  it("blocks non-allow-listed tracks from house_electronic", () => {
    const r = assertHouseElectronicStampAllowed(TRACK_IDS.NEVA_TOO_MUCH_PRADA, "house_electronic");
    expect(r.ok).toBe(false);
  });

  it("requires exact track_id for house_electronic (no title path)", () => {
    const r = assertHouseElectronicStampAllowed(null, "house_electronic");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/track_id/) });
  });

  it("allows house stamp on Control UUID", () => {
    expect(assertHouseElectronicStampAllowed(TRACK_IDS.CONTROL, "house_electronic").ok).toBe(true);
  });
});

describe("sync eligibility is not inferred from sample", () => {
  it("has_sample=no alone never returns sync-eligible", () => {
    expect(computeSyncEligible("no")).toBe(false);
    expect(computeSyncEligible("yes")).toBe(false);
    expect(computeSyncEligible("unknown")).toBe(false);
  });

  it("evaluateSyncReady requires explicit Fendi + DNA + rights gates", () => {
    const blocked = evaluateSyncReady({ hasSample: "no" });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers).toContain("approved_song_dna");
    expect(blocked.blockers).toContain("fendi_sync_approval");
    expect(blocked.blockers).toContain("fendi_sample_declaration_approval");

    const ready = evaluateSyncReady({
      hasSample: "no",
      approvedDnaVersionId: "dna-1",
      sampleDeclarationApproved: true,
      syncApprovedByFendi: true,
      splitsReady: true,
      publishingReady: true,
      assetsReady: true,
      unresolvedRightsException: false,
    });
    expect(ready.ready).toBe(true);
    expect(ready.blockers).toEqual([]);
  });

  it("has_sample=yes blocks unless sample exception is resolved", () => {
    const r = evaluateSyncReady({
      hasSample: "yes",
      approvedDnaVersionId: "dna-1",
      sampleDeclarationApproved: true,
      syncApprovedByFendi: true,
      splitsReady: true,
      publishingReady: true,
      assetsReady: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("sample_rights_exception");
  });

  it("Neva stays blocked without private license evidence", () => {
    const r = evaluateSyncReady({
      hasSample: "no",
      approvedDnaVersionId: "dna-1",
      sampleDeclarationApproved: true,
      syncApprovedByFendi: true,
      splitsReady: true,
      publishingReady: true,
      assetsReady: true,
      privateLicenseRequired: true,
      privateLicenseOnFile: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("private_license_evidence");
  });
});
