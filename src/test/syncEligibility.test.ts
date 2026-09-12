import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockerLabel,
  dnaConflictsWithComputedEligibility,
  formatActorStamp,
} from "@/lib/syncEligibility";

describe("sync eligibility client helpers", () => {
  it("labels known blockers and passes through unknown codes", () => {
    expect(blockerLabel("fendi_sync_approval")).toMatch(/Fendi sync approval/);
    expect(blockerLabel("custom_future_blocker")).toBe("custom_future_blocker");
  });

  it("surfaces DNA recommendation vs computed eligibility without merging them", () => {
    expect(dnaConflictsWithComputedEligibility("approved", false)).toBe(true);
    expect(dnaConflictsWithComputedEligibility("blocked", true)).toBe(true);
    expect(dnaConflictsWithComputedEligibility("approved", true)).toBe(false);
    expect(dnaConflictsWithComputedEligibility("blocked", false)).toBe(false);
    expect(dnaConflictsWithComputedEligibility(null, true)).toBe(false);
  });

  it("formats actor stamps without inventing identity", () => {
    expect(formatActorStamp(null, null)).toBeNull();
    expect(formatActorStamp("2026-09-01T00:00:00Z", "fendi")).toMatch(/fendi/);
  });
});

describe("sync eligibility UI + gate have no title special-cases", () => {
  const files = [
    "src/pages/admin/AdminCatalogue.tsx",
    "src/components/admin/TrackSyncEligibilityPanel.tsx",
    "src/lib/syncEligibility.ts",
    "supabase/functions/_shared/sync-gate.ts",
  ];

  it("does not hardcode catalogue titles in the reusable control", () => {
    for (const rel of files) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/Meditate/);
      expect(src).not.toMatch(/Designed For Me/);
      expect(src).not.toMatch(/Balenciaga/);
      expect(src).not.toMatch(/Electrilla/);
      expect(src).not.toMatch(/506ad12f-9e2e-450c-b2e9-f3d10670c015/);
    }
  });
});
