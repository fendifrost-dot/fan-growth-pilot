/**
 * Phase 0 send-gate integration tests.
 * Proves review-required contracts without hitting live Resend.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

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

describe("integration: sync gate", () => {
  it("sample=no is not sync-ready", () => {
    expect(computeSyncEligible("no")).toBe(false);
    expect(evaluateSyncReady({ hasSample: "no" }).ready).toBe(false);
  });
});

describe("integration: send identity contract (code presence)", () => {
  it("both playlist senders import the shared identity gate", () => {
    const execute = readFileSync(
      join(process.cwd(), "supabase/functions/execute-pitch/index.ts"),
      "utf8",
    );
    const alt = readFileSync(
      join(process.cwd(), "supabase/functions/send-pitch-email/index.ts"),
      "utf8",
    );
    expect(execute).toMatch(/requireSendIdentity/);
    expect(execute).toMatch(/requireHubKey/);
    expect(alt).toMatch(/requireSendIdentity/);
    expect(alt).toMatch(/requireHubKey/);
    expect(alt).toMatch(/track_id/);
    expect(alt).toMatch(/campaign_id/);
    // Playlist pitch_log insert must carry exact identity columns.
    const playlistInsert = alt.slice(alt.indexOf('from("pitch_log")'));
    expect(playlistInsert).toMatch(/track_id/);
    expect(playlistInsert).toMatch(/campaign_id/);
    expect(playlistInsert).toMatch(/status:\s*"sent"/);
  });

  it("activation derives approver from admin actor, not body text", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/pitch-campaigns.ts"),
      "utf8",
    );
    expect(src).toMatch(/Server-derived only/);
    expect(src).toMatch(/const fendiBy = actor\.userId/);
    expect(src).not.toMatch(
      /fendiBy = String\(body\.fendi_activation_approved_by/,
    );
  });

  it("createCampaign rejects non-draft status on create", () => {
    const src = readFileSync(
      join(process.cwd(), "supabase/functions/_shared/pitch-campaigns.ts"),
      "utf8",
    );
    expect(src).toMatch(/Campaigns always create as draft/);
    expect(src).toMatch(/\.in\('status', \['draft', 'active', 'paused'\]\)/);
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

describe("integration: migration sequencing contracts", () => {
  it("Control backfill migration exists before campaign-gate require migration", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const backfill = files.find((f) => f.includes("control_pitch_log_track_id_backfill"));
    const requireGate = files.find((f) => f.includes("campaign_gate_require"));
    expect(backfill).toBeTruthy();
    expect(requireGate).toBeTruthy();
    expect(backfill! < requireGate!).toBe(true);
  });

  it("campaign gate require migration fails loudly without pitch_campaigns", () => {
    const sql = readFileSync(
      join(MIGRATIONS, "20260902200000_campaign_gate_require_and_control_backfill.sql"),
      "utf8",
    );
    expect(sql).toMatch(/to_regclass\('public\.pitch_campaigns'\) is null/);
    expect(sql).toMatch(/raise exception/i);
    expect(sql).toMatch(/pitch_log_campaign_id_fkey/);
    expect(sql).toMatch(/fendi_activation_approved_by/);
    expect(sql).toMatch(/song_dna_version_id/);
  });

  it("Control backfill migration asserts leftover = 0", () => {
    const sql = readFileSync(
      join(MIGRATIONS, "20260902190000_control_pitch_log_track_id_backfill.sql"),
      "utf8",
    );
    expect(sql).toMatch(/5d09da7e-98cf-4276-8dca-861d1fbbfa98/);
    expect(sql).toMatch(/designed for me/);
    expect(sql).toMatch(/leftover/);
  });
});
