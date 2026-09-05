import { describe, it, expect } from "vitest";
import type { Database } from "@/integrations/supabase/types";

type PublicTables = Database["public"]["Tables"];

describe("supabase types cover AGH Phase 1 tables/columns", () => {
  it("includes Song DNA, private license, ops, press, campaigns, lyrics, splits", () => {
    type SongDna = PublicTables["song_dna_versions"]["Row"];
    type License = PublicTables["private_license_evidence"]["Row"];
    type Ops = PublicTables["ops_incidents"]["Row"];
    type Press = PublicTables["press_kits"]["Row"];
    type Campaign = PublicTables["pitch_campaigns"]["Row"];
    type Lyrics = PublicTables["lyrics_transcriptions"]["Row"];
    type Split = PublicTables["split_sheets"]["Row"];
    type Contrib = PublicTables["split_sheet_contributors"]["Row"];
    type PlaylistOps = PublicTables["playlist_ops_ledger"]["Row"];

    const keys = [
      null as SongDna | null,
      null as License | null,
      null as Ops | null,
      null as Press | null,
      null as Campaign | null,
      null as Lyrics | null,
      null as Split | null,
      null as Contrib | null,
      null as PlaylistOps | null,
    ];
    expect(keys.every((k) => k === null)).toBe(true);
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

  it("includes playlist ops ledger attribution columns", () => {
    type Ledger = PublicTables["playlist_ops_ledger"]["Row"];
    const keys: Array<keyof Ledger> = [
      "track_id",
      "approval_result",
      "approved_by",
      "sent_by",
      "drafted_by",
    ];
    expect(keys.length).toBe(5);
  });
});
