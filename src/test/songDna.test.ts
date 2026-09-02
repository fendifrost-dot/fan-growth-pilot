import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DNA_STATE_LABEL,
  isEditableDnaState,
  parseLaneList,
} from "@/lib/songDna";
import { evaluateSyncReady } from "@/lib/catalogRules";

describe("songDna client helpers", () => {
  it("labels every approval state", () => {
    expect(DNA_STATE_LABEL.pending_fendi_review).toMatch(/Fendi/);
    expect(isEditableDnaState("draft")).toBe(true);
    expect(isEditableDnaState("approved")).toBe(false);
  });

  it("parses lane lists", () => {
    expect(parseLaneList("rap_general, deep_house_groove\nclub")).toEqual([
      "rap_general",
      "deep_house_groove",
      "club",
    ]);
  });

  it("sync ready still requires approved DNA id", () => {
    expect(evaluateSyncReady({}).blockers).toContain("approved_song_dna");
  });
});

describe("song DNA migration + wiring contracts", () => {
  it("migration file exists and forbids auto-approval", () => {
    const path = join(process.cwd(), "supabase/migrations/20260903000000_song_dna_versions.sql");
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, "utf8");
    expect(sql).toMatch(/pending_fendi_review/);
    expect(sql).toMatch(/Never auto-approved/i);
    expect(sql).toMatch(/song_dna_audit_events/);
  });

  it("CCA dispatches song DNA through authorizeAction", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/control-center-api/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/isSongDnaAction/);
    expect(src).toMatch(/runSongDnaAction/);
    expect(src).toMatch(/authorizeAction/);
  });

  it("Pitch Portal passes song_dna_version_id on activate", () => {
    const src = readFileSync(
      join(process.cwd(), "src/pages/admin/AdminPitchPortal.tsx"),
      "utf8",
    );
    expect(src).toMatch(/song_dna_version_id: dna\.id/);
  });
});
