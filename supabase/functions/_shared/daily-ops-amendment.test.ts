/**
 * PR #19 amendment regressions — approval bypasses, DNA gates, sync verify,
 * scoped reads, state transitions, attribution, conversion math.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  resolveOpsActor,
} from "./ops-actors.ts";
import {
  authorizeHandoffState,
  canTransitionHandoff,
  CLAUDE_SIDE_STATES,
  FINAL_AUTHORITY_STATES,
  HANDOFF_TRANSITIONS,
  assertKnownChannel,
} from "./handoff-queues.ts";
import { assertPacketDnaEnvelope } from "./multichannel-path.ts";
import { verifiedToDraftRate, computeDailyRawRequirement } from "./discovery-capacity.ts";
import { requiredCapabilityForAction } from "./outreach-auth.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}

function withEnv(vars: Record<string, string>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("amendment: Claude/service cannot set APPROVED_FOR_SEND or REJECTED_BY_GROK", () => {
  withEnv({
    CLAUDE_AGENT_SECRET: "claude-secret",
    FANFUEL_HUB_KEY: "hub-key",
  }, () => {
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    const service = resolveOpsActor(null, req({ "x-api-key": "hub-key" }));
    assert(authorizeHandoffState(claude, "APPROVED_FOR_SEND") != null);
    assert(authorizeHandoffState(claude, "REJECTED_BY_GROK") != null);
    assert(authorizeHandoffState(claude, "GROK_REVIEWED") != null);
    assert(authorizeHandoffState(claude, "IMPORTED_TO_AGH") != null);
    assert(authorizeHandoffState(service, "APPROVED_FOR_SEND") != null);
    assertEquals(authorizeHandoffState(claude, "CLAUDE_BATCH_READY"), null);
    assertEquals(authorizeHandoffState(claude, "AWAITING_GROK_REVIEW"), null);
  });
});

Deno.test("amendment: human_admin cannot approve/reject handoff as final authority", () => {
  withEnv({ ARTIST_USER_ID: "fendi-exact-id" }, () => {
    const admin = resolveOpsActor(
      { kind: "user", userId: "other-admin", isAdmin: true },
      null,
    );
    assertEquals(admin.kind, "human_admin");
    assert(authorizeHandoffState(admin, "APPROVED_FOR_SEND") != null);
    assert(authorizeHandoffState(admin, "REJECTED_BY_GROK") != null);
    assert(authorizeHandoffState(admin, "GROK_REVIEWED") != null);
    // review_handoff_batch remains Grok/Fendi — human_admin lacks it
    assertEquals(can(admin, "review_handoff_batch"), false);
    assertEquals(can(admin, "approve_playlist_drafts"), false);
  });
});

Deno.test("amendment: Grok can approve/reject; Claude lacks review_handoff_batch", () => {
  withEnv({
    CLAUDE_AGENT_SECRET: "claude-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, () => {
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    assertEquals(can(claude, "review_handoff_batch"), false);
    assertEquals(can(claude, "read_daily_ops"), false);
    assertEquals(can(grok, "review_handoff_batch"), true);
    assertEquals(authorizeHandoffState(grok, "APPROVED_FOR_SEND"), null);
    assertEquals(authorizeHandoffState(grok, "REJECTED_BY_GROK"), null);
  });
});

Deno.test("amendment: handoff transitions are single-step; no skip to APPROVED", () => {
  assertEquals(canTransitionHandoff("CLAUDE_BATCH_READY", "AWAITING_GROK_REVIEW"), false);
  assertEquals(canTransitionHandoff("CLAUDE_BATCH_READY", "CLAUDE_PLAYLIST_COMPLETE"), true);
  assertEquals(canTransitionHandoff("CLAUDE_BATCH_READY", "APPROVED_FOR_SEND"), false);
  assertEquals(canTransitionHandoff("AWAITING_GROK_REVIEW", "APPROVED_FOR_SEND"), false);
  assertEquals(canTransitionHandoff("AWAITING_GROK_REVIEW", "GROK_REVIEWED"), true);
  assertEquals(canTransitionHandoff("GROK_REVIEWED", "APPROVED_FOR_SEND"), true);
  assertEquals(canTransitionHandoff("REJECTED_BY_GROK", "APPROVED_FOR_SEND"), false);
  assertEquals(canTransitionHandoff("IMPORTED_TO_AGH", "CLAUDE_BATCH_READY"), false);
  assert(CLAUDE_SIDE_STATES.has("AWAITING_GROK_REVIEW"));
  assert(FINAL_AUTHORITY_STATES.has("APPROVED_FOR_SEND"));
  assertEquals(HANDOFF_TRANSITIONS.CLAUDE_BATCH_READY.includes("APPROVED_FOR_SEND"), false);
});

Deno.test("amendment: form/DM DNA gate is mandatory (not require_dna flag)", () => {
  assert(assertPacketDnaEnvelope({ form_url: "https://x.test" }) != null);
  assert(assertPacketDnaEnvelope({ song_dna_version_id: "00000000-0000-0000-0000-000000000001" }) != null);
  assertEquals(
    assertPacketDnaEnvelope({
      track_id: "track-1",
      song_dna_version_id: "00000000-0000-0000-0000-000000000001",
    }),
    null,
  );
  const multi = Deno.readTextFileSync(new URL("./multichannel-path.ts", import.meta.url));
  assert(!multi.includes("if (clean.require_dna)"));
  assert(multi.includes("enforceTrackDnaLaneEnvelope"));
  assert(multi.includes("track_id"));
});

Deno.test("amendment: conversion rate is drafted∩verified / verified (not drafts/verified counts)", () => {
  assertEquals(verifiedToDraftRate(["a", "b", "c", "d"], ["a", "c", "z"]), 0.5);
  assertEquals(verifiedToDraftRate([], ["a"]), 0);
  assertEquals(verifiedToDraftRate(["a"], []), 0);
  // Old flawed formula would allow drafts>verified → capped nonsense; intersection stays ≤1
  assertEquals(verifiedToDraftRate(["a", "b"], ["a", "b", "c", "d", "e"]), 1);
  const raw = computeDailyRawRequirement({
    activePitchingSongs: 1,
    conversionRate: verifiedToDraftRate(["a", "b"], ["a"]),
    minConversionRate: 0.05,
  });
  assertEquals(raw, Math.ceil(30 / 0.5));
});

Deno.test("amendment: unknown channels still fail closed", () => {
  assert(assertKnownChannel("sms_blast") != null);
  assertEquals(assertKnownChannel("email"), null);
  assertEquals(assertKnownChannel("web_form"), null);
  assertEquals(assertKnownChannel("instagram_dm"), null);
});

Deno.test("amendment: mark_manual_* still requires send capability; review_handoff is separate", () => {
  assertEquals(requiredCapabilityForAction("mark_manual_form_submitted"), "send_playlist_pitches");
  assertEquals(requiredCapabilityForAction("review_handoff_batch"), "review_handoff_batch");
  assertEquals(requiredCapabilityForAction("list_sync_research_targets"), "read_own_sync_batches");
  assertEquals(requiredCapabilityForAction("get_daily_ops_dashboard"), "read_daily_ops");
  assertEquals(requiredCapabilityForAction("get_daily_station_run"), "run_daily_station");
});

Deno.test("amendment: sync verify source requires contact path + evidence (code contract)", () => {
  const src = Deno.readTextFileSync(new URL("./sync-research.ts", import.meta.url));
  assert(src.includes("missing_verified_contact_path"));
  assert(src.includes("missing_source_evidence"));
  assert(src.includes("false_verify: false"));
  assert(src.includes("scoped: !unscopedSyncReader(ops)"));
  // Must not blindly .update(...).in("id", ids) without per-row checks
  assert(!/status:\s*"verified"[\s\S]{0,80}\.in\("id", ids\)/.test(src));
});

Deno.test("amendment: handoff does not overwrite discovered_by on advance", () => {
  const src = Deno.readTextFileSync(new URL("./handoff-queues.ts", import.meta.url));
  assert(src.includes("never overwrite discovered_by"));
  assert(src.includes("illegal_transition"));
  assert(src.includes("invalid_initial_state"));
  assert(src.includes("recountBatchRecords"));
});

Deno.test("amendment: station resume preserves actor_* (completed_by separate)", () => {
  const src = Deno.readTextFileSync(new URL("./daily-ops.ts", import.meta.url));
  assert(src.includes("preserve original authenticated actor attribution"));
  assert(src.includes("completed_by: attr.actor_kind"));
  assert(src.includes("last_resumed_by"));
  // Resume patch must not reassign actor_kind (only last_resumed_by).
  const resumeIdx = src.indexOf("preserve original authenticated actor attribution");
  const resumeSlice = src.slice(resumeIdx, resumeIdx + 900);
  assert(!resumeSlice.includes("actor_kind: attr.actor_kind"));
  assert(resumeSlice.includes("last_resumed_by: attr.actor_kind"));
});

Deno.test("amendment migration adds FKs and completed_by", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../migrations/20260907010000_daily_ops_pr19_security_amendment.sql", import.meta.url),
  );
  assert(sql.includes("daily_ops_station_runs_input_batch_fkey"));
  assert(sql.includes("agh_handoff_records_playlist_target_fkey"));
  assert(sql.includes("agh_handoff_records_song_dna_fkey"));
  assert(sql.includes("completed_by"));
  assert(sql.includes("playlist_targets_song_dna_fkey"));
});
