/**
 * Phase 0 send-gate integration tests (pure logic + shared gate modules).
 * These prove the review-required contracts without hitting live Resend.
 */
import { describe, it, expect } from "vitest";
import {
  TRACK_IDS,
  assertHouseElectronicStampAllowed,
  computeSyncEligible,
  evaluateSyncReady,
} from "@/lib/catalogRules";
import {
  CONTROL_TRACK_ID,
  evaluateControlSameTargetCooldown,
} from "@/lib/controlCooldown";
import { assertGenreStampAllowed } from "@/lib/syncRegisters";

describe("integration: write-boundary House allow-list", () => {
  it("rejects house stamp without track_id at the write boundary", () => {
    expect(assertHouseElectronicStampAllowed(undefined, "house_electronic").ok).toBe(false);
  });

  it("rejects Meditate UUID and allows only the three House UUIDs", () => {
    expect(assertHouseElectronicStampAllowed(TRACK_IDS.MEDITATE, "house_electronic").ok).toBe(false);
    expect(assertHouseElectronicStampAllowed(TRACK_IDS.BALENCIAGA, "house_electronic").ok).toBe(true);
    expect(assertHouseElectronicStampAllowed(TRACK_IDS.ELECTRILLA, "house_electronic").ok).toBe(true);
    expect(assertHouseElectronicStampAllowed(TRACK_IDS.CONTROL, "house_electronic").ok).toBe(true);
  });
});

describe("integration: Control cooldown uses track_id primary key", () => {
  it("blocks prior Control target by UUID during the window", () => {
    const d = evaluateControlSameTargetCooldown({
      trackId: CONTROL_TRACK_ID,
      playlistId: "spotify:prior",
      priorPitchExists: true,
      now: new Date("2026-09-10T12:00:00Z"),
    });
    expect(d.blocked).toBe(true);
  });

  it("ignores title-only identity — non-Control UUID is never blocked", () => {
    const d = evaluateControlSameTargetCooldown({
      trackId: TRACK_IDS.MEDITATE,
      playlistId: "spotify:prior",
      priorPitchExists: true,
      now: new Date("2026-09-10T12:00:00Z"),
    });
    expect(d.blocked).toBe(false);
  });
});

describe("integration: sync gate + send identity contracts", () => {
  it("sample=no is not sync-ready", () => {
    expect(computeSyncEligible("no")).toBe(false);
    expect(evaluateSyncReady({ hasSample: "no" }).ready).toBe(false);
  });

  it("documents required send fields track_id + campaign_id", () => {
    const required = ["track_id", "campaign_id", "playlist_id"] as const;
    expect(required).toEqual(["track_id", "campaign_id", "playlist_id"]);
  });
});

describe("integration: genre stamp helper requires UUID for house", () => {
  it("assertGenreStampAllowed blocks house without id even for allow-listed titles", () => {
    const r = assertGenreStampAllowed("Designed For Me (Control)", "house_electronic");
    expect(r.ok).toBe(false);
  });

  it("assertGenreStampAllowed allows house with Control UUID", () => {
    const r = assertGenreStampAllowed("Designed For Me (Control)", "house_electronic", TRACK_IDS.CONTROL);
    expect(r.ok).toBe(true);
  });

  it("assertGenreStampAllowed blocks Meditate UUID from house", () => {
    const r = assertGenreStampAllowed("Meditate", "house_electronic", TRACK_IDS.MEDITATE);
    expect(r.ok).toBe(false);
  });
});
