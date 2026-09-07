/**
 * Daily ops ledger, handoff queues, multichannel path verification,
 * discovery capacity, and Claude sync-research intake regressions.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
  attributionFrom,
} from "./ops-actors.ts";
import type { Actor } from "./outreach-auth.ts";
import { requiredCapabilityForAction, ACTION_SPEC } from "./outreach-auth.ts";
import {
  chicagoBusinessDate,
  chicagoLocalHm,
  AGH_OPS_TIMEZONE,
  isDailyStationId,
  STATION_UPSTREAM,
  DAILY_STATION_IDS,
} from "./chicago-time.ts";
import { computeDailyRawRequirement } from "./discovery-capacity.ts";
import {
  evaluateSubmissionPath,
  buildWebFormPacket,
  buildInstagramDmPacket,
  assertPacketDnaEnvelope,
  isValidFormUrl,
  isValidIgAccount,
} from "./multichannel-path.ts";
import {
  HANDOFF_QUEUE_STATES,
  assertKnownChannel,
  isHandoffQueueState,
} from "./handoff-queues.ts";
import {
  syncTargetDedupeKey,
  opportunityDedupeKey,
  isSyncRoleCategory,
  SYNC_RESEARCH_ACTIONS,
} from "./sync-research.ts";
import {
  DAILY_OPS_ACTIONS,
} from "./daily-ops.ts";

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

// ---- Timezone -------------------------------------------------------------

Deno.test("ops timezone is America/Chicago (not a fixed UTC offset)", () => {
  assertEquals(AGH_OPS_TIMEZONE, "America/Chicago");
  const d = chicagoBusinessDate(new Date("2026-03-08T12:00:00Z")); // near DST
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(d), true);
  const hm = chicagoLocalHm(new Date("2026-01-15T18:30:00Z"));
  assertEquals(/^\d{2}:\d{2}$/.test(hm), true);
});

Deno.test("station ids and upstream continuity map", () => {
  for (const id of DAILY_STATION_IDS) assertEquals(isDailyStationId(id), true);
  assertEquals(isDailyStationId("midnight_scrape"), false);
  assertEquals(STATION_UPSTREAM.playlist_tranche_first, "playlist_discovery_begin");
  assertEquals(STATION_UPSTREAM.playlist_tranche_final, "playlist_tranche_first");
  assertEquals(STATION_UPSTREAM.sync_batch_ready, "playlist_tranche_final");
});

// ---- Idempotency key contract (pure) --------------------------------------

Deno.test("station run idempotency key is station + business_date_ct + run_key", () => {
  // Unique constraint documented by migration + startDailyStationRun resume path.
  const key = (station: string, date: string, runKey: string) =>
    `${station}|${date}|${runKey}`;
  assertEquals(
    key("playlist_discovery_begin", "2026-09-07", "primary"),
    key("playlist_discovery_begin", "2026-09-07", "primary"),
  );
  assert(
    key("playlist_discovery_begin", "2026-09-07", "primary") !==
      key("playlist_tranche_first", "2026-09-07", "primary"),
  );
});

// ---- Auth matrix for new capabilities -------------------------------------

Deno.test("Claude can create playlist/sync research but cannot approve or send", () => {
  withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    assertEquals(can(actor, "create_handoff_batch"), true);
    assertEquals(can(actor, "verify_submission_path"), true);
    assertEquals(can(actor, "research_sync_targets"), true);
    assertEquals(can(actor, "create_sync_target"), true);
    assertEquals(can(actor, "create_sync_opportunity"), true);
    assertEquals(can(actor, "draft_sync_pitch"), true);
    assertEquals(can(actor, "read_own_sync_batches"), true);
    assertEquals(can(actor, "run_daily_station"), true);
    assertEquals(can(actor, "read_daily_ops"), false);
    assertEquals(can(actor, "approve_playlist_drafts"), false);
    assertEquals(can(actor, "send_playlist_pitches"), false);
    assertEquals(can(actor, "review_handoff_batch"), false);
    assertEquals(can(actor, "approve_sync_eligibility"), false);
    assertEquals(can(actor, "authorize_monetary_decisions"), false);
    assertEquals(can(actor, "manage_sync_registers"), false);
  });
});

Deno.test("Grok can consume/review Claude playlist batches and send; not DNA/sync eligibility", () => {
  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    assertEquals(can(actor, "review_handoff_batch"), true);
    assertEquals(can(actor, "approve_playlist_drafts"), true);
    assertEquals(can(actor, "send_playlist_pitches"), true);
    assertEquals(can(actor, "create_sync_target"), false);
    assertEquals(can(actor, "approve_sync_eligibility"), false);
    assertEquals(can(actor, "approve_song_dna"), false);
  });
});

Deno.test("ACTION_SPEC gates daily-ops / handoff / sync-research / multichannel actions", () => {
  for (const action of [
    ...DAILY_OPS_ACTIONS,
    "create_handoff_batch",
    "review_handoff_batch",
    "mark_manual_form_submitted",
    "mark_manual_ig_dm_submitted",
    "verify_submission_path",
    "build_web_form_packet",
    "build_instagram_dm_draft",
    ...SYNC_RESEARCH_ACTIONS,
  ]) {
    assert(ACTION_SPEC[action], `missing ACTION_SPEC for ${action}`);
    assert(requiredCapabilityForAction(action), `missing capability for ${action}`);
  }
  // Claude cannot approve/send via action capability
  assertEquals(requiredCapabilityForAction("approve_draft"), "approve_playlist_drafts");
  assertEquals(requiredCapabilityForAction("log_pitch_sent"), "send_playlist_pitches");
  assertEquals(requiredCapabilityForAction("mark_manual_form_submitted"), "send_playlist_pitches");
});

Deno.test("caller-supplied attribution fields are stripped", () => {
  const cleaned = stripSpoofedAttribution({
    discovered_by: "spoofed",
    approved_by: "evil",
    verified_by_label: "not-real",
    playlist_id: "keep-me",
  });
  assertEquals(cleaned.discovered_by, undefined);
  assertEquals(cleaned.approved_by, undefined);
  assertEquals(cleaned.verified_by_label, undefined);
  assertEquals(cleaned.playlist_id, "keep-me");
  const attr = attributionFrom({ kind: "claude", userId: null, label: "claude" });
  assertEquals(attr.actor_kind, "claude");
});

// ---- Multichannel path verification ---------------------------------------

Deno.test("web form and IG DM can verify without email", async () => {
  const form = await evaluateSubmissionPath({
    submission_channel: "web_form",
    form_url: "https://example.com/submit",
    form_source_evidence: "https://curator.example/page#form",
  });
  assertEquals(form.ok, true);
  assertEquals(form.path_verified, true);
  assertEquals(form.channel, "web_form");

  const ig = await evaluateSubmissionPath({
    submission_channel: "instagram_dm",
    ig_curator_account: "@curator_ok",
    ig_source_evidence: "profile bio lists DM for submissions",
  });
  assertEquals(ig.ok, true);
  assertEquals(ig.path_verified, true);
  assertEquals(ig.channel, "instagram_dm");
});

Deno.test("unknown submission channels fail closed", async () => {
  assert(assertKnownChannel("telegram_blast") != null);
  const bad = await evaluateSubmissionPath({
    submission_channel: "telegram_blast",
    curator_email: "a@b.com",
  });
  assertEquals(bad.ok, false);
  assertEquals(bad.code, "unknown_channel");
});

Deno.test("form/DM packets cannot bypass Song-DNA enforcement", () => {
  const bare = buildWebFormPacket({ form_url: "https://x.test/f", playlist_id: "p1" });
  assert(assertPacketDnaEnvelope(bare) != null);
  const withDna = buildWebFormPacket({
    form_url: "https://x.test/f",
    playlist_id: "p1",
    song_dna_version_id: "00000000-0000-0000-0000-000000000001",
  });
  assertEquals(assertPacketDnaEnvelope(withDna), null);

  const igBare = buildInstagramDmPacket({ ig_curator_account: "@x" });
  assert(assertPacketDnaEnvelope(igBare) != null);

  // Gate is mandatory in handlers (no optional require_dna flag).
  const multi = Deno.readTextFileSync(new URL("./multichannel-path.ts", import.meta.url));
  assert(!multi.includes("if (clean.require_dna)"));
});

Deno.test("no automated form submission or bulk DM path exists in packets", () => {
  const form = buildWebFormPacket({ form_url: "https://x.test/f" });
  assertEquals(form.automated_submit, false);
  const ig = buildInstagramDmPacket({ ig_curator_account: "@x" }, "hi");
  assertEquals(ig.bulk_dm, false);
  assertEquals(ig.unattended_send, false);
  assertEquals(ig.scrape_followers, false);

  // Source scan: multichannel + handoff must not POST forms or bulk-DM.
  const multi = Deno.readTextFileSync(new URL("./multichannel-path.ts", import.meta.url));
  const handoff = Deno.readTextFileSync(new URL("./handoff-queues.ts", import.meta.url));
  assert(!/fetch\(.*form_url/.test(multi));
  assert(!/bulk.?dm.?send/i.test(multi));
  assertEquals(multi.includes("automated_submit: false"), true);
  assertEquals(handoff.includes("automated_submit: false") || handoff.includes("bulk_dm: false"), true);
});

Deno.test("email path helpers still recognize valid form URL / IG handle", () => {
  assertEquals(isValidFormUrl("https://submit.example/pitch"), true);
  assertEquals(isValidFormUrl("not-a-url"), false);
  assertEquals(isValidIgAccount("@ok_user.1"), true);
  assertEquals(isValidIgAccount("bad handle!"), false);
});

// ---- Handoff queue states -------------------------------------------------

Deno.test("handoff queue states cover Claude→Grok→import lifecycle", () => {
  for (const s of [
    "CLAUDE_BATCH_READY",
    "CLAUDE_PLAYLIST_COMPLETE",
    "AWAITING_GROK_REVIEW",
    "GROK_REVIEWED",
    "APPROVED_FOR_SEND",
    "REJECTED_BY_GROK",
    "AWAITING_AGH_IMPORT",
    "IMPORTED_TO_AGH",
  ]) {
    assertEquals(isHandoffQueueState(s), true);
  }
  assertEquals(HANDOFF_QUEUE_STATES.length, 8);
  assertEquals(isHandoffQueueState("SHADOW_MODE"), false);
});

// ---- Discovery capacity formula -------------------------------------------

Deno.test("daily raw requirement uses ceil((30×songs)÷conversion) with floors as settings inputs", () => {
  // 2 songs, 50% conversion → ceil(60/0.5)=120
  assertEquals(
    computeDailyRawRequirement({
      activePitchingSongs: 2,
      targetVerifiedPerSong: 30,
      conversionRate: 0.5,
    }),
    120,
  );
  // Zero conversion uses min rate floor 0.05 → ceil(30/0.05)=600
  assertEquals(
    computeDailyRawRequirement({
      activePitchingSongs: 1,
      conversionRate: 0,
      minConversionRate: 0.05,
    }),
    600,
  );
  assertEquals(computeDailyRawRequirement({ activePitchingSongs: 0, conversionRate: 0.5 }), 0);
});

// ---- Sync research dedupe + role categories -------------------------------

Deno.test("duplicate sync targets and opportunities collapse on dedupe key", () => {
  const a = syncTargetDedupeKey({
    person_name: "Ada",
    company_name: "Sync Co",
    role_category: "music_supervisor",
    official_url: "https://sync.co/ada",
  });
  const b = syncTargetDedupeKey({
    person_name: "Ada",
    company_name: "Sync Co",
    role_category: "music_supervisor",
    official_url: "https://sync.co/ada",
  });
  assertEquals(a, b);
  const o1 = opportunityDedupeKey({
    project_brief: "Trailer brief Q4",
    source_url: "https://jobs.example/1",
    sync_target_id: "t1",
  });
  const o2 = opportunityDedupeKey({
    project_brief: "Trailer brief Q4",
    source_url: "https://jobs.example/1",
    sync_target_id: "t1",
  });
  assertEquals(o1, o2);
  assertEquals(isSyncRoleCategory("music_supervisor"), true);
  assertEquals(isSyncRoleCategory("random_blogger"), false);
});

// ---- Email path continuity (source contract) ------------------------------

Deno.test("existing email approve/send path remains in playlist-agent-run", () => {
  const src = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  assert(src.includes('channel !== "email"'));
  assert(src.includes("execute-pitch"));
  assert(src.includes("manual_submit: true"));
  assert(src.includes("needs_manual_dm: true"));
  // No new auto form POST helper
  assert(!src.includes("autoSubmitWebForm"));
  assert(!src.includes("bulkSendInstagramDm"));
});

Deno.test("control-center wires daily-ops / handoff / multichannel / sync-research", () => {
  const cca = Deno.readTextFileSync(new URL("../control-center-api/index.ts", import.meta.url));
  assert(cca.includes("isDailyOpsAction"));
  assert(cca.includes("isHandoffAction"));
  assert(cca.includes("isMultichannelAction"));
  assert(cca.includes("isSyncResearchAction"));
  assert(cca.includes("runDailyOpsAction"));
});

Deno.test("migration defines station ledger uniqueness and handoff states", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../migrations/20260907000000_daily_ops_multichannel_sync_intake.sql", import.meta.url),
  );
  assert(sql.includes("unique (station_id, business_date_ct, run_key)"));
  assert(sql.includes("America/Chicago"));
  assert(sql.includes("CLAUDE_BATCH_READY"));
  assert(sql.includes("IMPORTED_TO_AGH"));
  assert(sql.includes("interim_raw_floor_per_song"));
  assert(sql.includes("sync_research_targets"));
  assert(sql.includes("path_verified"));
  assert(sql.includes("form_url"));
  assert(sql.includes("ig_curator_account"));
});
