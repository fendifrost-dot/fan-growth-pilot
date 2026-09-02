import { describe, it, expect } from "vitest";
import type { Database } from "@/integrations/supabase/types";

type PublicTables = Database["public"]["Tables"];

describe("supabase types cover AGH Phase 1 tables/columns", () => {
  it("includes Song DNA, private license, ops, press", () => {
    type SongDna = PublicTables["song_dna_versions"]["Row"];
    type License = PublicTables["private_license_evidence"]["Row"];
    type Ops = PublicTables["ops_incidents"]["Row"];
    type Press = PublicTables["press_kits"]["Row"];

    const dna = null as SongDna | null;
    const lic = null as License | null;
    const ops = null as Ops | null;
    const press = null as Press | null;
    expect(dna).toBeNull();
    expect(lic).toBeNull();
    expect(ops).toBeNull();
    expect(press).toBeNull();
  });

  it("includes draft/send identity + sync gate columns", () => {
    type Draft = PublicTables["outreach_drafts"]["Row"];
    type Pitch = PublicTables["pitch_log"]["Row"];
    type Track = PublicTables["tracks"]["Row"];

    const draftKeys: Array<keyof Draft> = ["track_id", "campaign_id"];
    const pitchKeys: Array<keyof Pitch> = ["track_id", "campaign_id"];
    const trackKeys: Array<keyof Track> = [
      "approved_song_dna_version_id",
      "sync_approved_at",
      "sync_eligible_blockers",
      "sample_exception_resolved",
    ];
    expect(draftKeys.length).toBe(2);
    expect(pitchKeys.length).toBe(2);
    expect(trackKeys.length).toBe(4);
  });
});
