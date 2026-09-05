import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DNA_STATE_LABEL,
  isEditableDnaState,
  parseLaneList,
  evaluateSyncReady,
} from "@/lib/songDna";

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
    const path = join(
      process.cwd(),
      "supabase/migrations/20260905000000_outreach_dna_discovery_identity.sql",
    );
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, "utf8");
    expect(sql).toMatch(/pending_fendi_review/);
    expect(sql).toMatch(/Never auto-approved/i);
    expect(sql).toMatch(/song_dna_audit_events/);
    expect(sql).toMatch(/discovery_profiles/);
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

  it("runtime song-dna has no catalog track UUID literals", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/song-dna.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/506ad12f-9e2e-450c-b2e9-f3d10670c015/);
    expect(src).not.toMatch(/TRACK_IDS/);
    expect(src).toMatch(/requires_private_license/);
  });

  it("Song DNA selects use the explicit track_id FK embed alias", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/song-dna.ts"),
      "utf8",
    );
    expect(src).toContain("tracks:tracks!song_dna_versions_track_id_fkey(name)");
    expect(src).toContain("SONG_DNA_TRACKS_EMBED");
    expect(src).not.toMatch(/select\(["'`][^"'`]*tracks\(name\)/);
    expect(src).not.toMatch(/,\s*tracks\(name\)["'`]/);
  });
});
