import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluatePreSendGate, type PreSendInput } from "./pre-send-gate.ts";
import { graphDmPrepare } from "./ig-graph-dm.ts";
import {
  igCuratorDailyCap,
  igCuratorSendEnabled,
  memoryClaimStore,
  runIgCuratorDispatch,
  type IgDmTransport,
  type IgSendCandidate,
} from "./ig-curator-auto-send.ts";
import { capabilitiesFor } from "./ops-actors.ts";

const NOW = Date.parse("2026-10-26T15:00:00.000Z");
const FRESH = "2026-10-25T15:00:00.000Z";

function passingInput(mutate?: (row: PreSendInput) => void): PreSendInput {
  const row: PreSendInput = {
    channel: "instagram_dm",
    now: NOW,
    copy: { body: "DM body", subject: null, recipient: "@curator" },
    record: {
      id: "rec-1",
      batch_id: "batch-1",
      track_id: "track-1",
      playlist_target_id: "pl-1",
      queue_state: "APPROVED_FOR_SEND",
      submission_channel: "instagram_dm",
      song_dna_version_id: "dna-1",
      approved_by: "grok_playlist_control",
      packet: {},
    },
    recordStatus: "ok",
    batch: { id: "batch-1", queue_state: "APPROVED_FOR_SEND", approved_by: "grok_playlist_control" },
    batchStatus: "ok",
    track: { id: "track-1", name: "Meditate", approved_song_dna_version_id: "dna-1" },
    dna: {
      id: "dna-1",
      track_id: "track-1",
      approval_state: "approved",
      approved_by: "fendi-user",
      approved_lanes: ["rap_trap_hype"],
      excluded_lanes: [],
      primary_genre: "hip_hop_rap",
    },
    dnaStatus: "ok",
    draftDnaId: "dna-1",
    target: {
      playlist_id: "pl-1",
      is_active: true,
      pitch_status: "ready",
      verification_status: "manually_verified",
      path_verified: true,
      lane: "rap_trap_hype",
      submission_cost: "unknown",
      last_verified_at: FRESH,
      ig_verified_at: FRESH,
      ig_curator_account: "curator",
      ig_source_evidence: "IG bio says DM for playlist submissions",
      research_context: { identity_resolved: true },
      contact_method: "instagram_dm",
    },
    targetStatus: "ok",
    sendPlaylistId: "pl-1",
    sendTrackId: "track-1",
    clearance: { ok: true, code: "eligible" },
    operator: "clear",
    blocklist: "not_applicable",
  };
  mutate?.(row);
  return row;
}

function candidate(mutate?: (row: PreSendInput) => void, extra: Partial<IgSendCandidate> = {}): IgSendCandidate {
  const decision = evaluatePreSendGate(passingInput(mutate));
  return {
    handoffRecordId: "rec-1",
    trackId: "track-1",
    playlistId: "pl-1",
    handle: "curator",
    body: decision.dispatch?.body ?? "",
    recipientId: "igsid-1",
    optedOut: false,
    priorReceipt: false,
    decision,
    ...extra,
  };
}

function recordingTransport() {
  const sent: string[] = [];
  const transport: IgDmTransport = {
    prepare: () => ({ ok: true }),
    send: async (args) => {
      sent.push(`${args.handoffRecordId}:${args.handle}`);
      return { ok: true, providerMessageId: `mid-${args.handoffRecordId}` };
    },
  };
  return { transport, sent };
}

Deno.test("auto-send: a gate pass sends once and returns the provider id", async () => {
  const { transport, sent } = recordingTransport();
  const ran = await runIgCuratorDispatch({
    enabled: true,
    dailyCap: 10,
    now: NOW,
    candidates: [candidate()],
    claims: memoryClaimStore(NOW),
    transport,
  });
  assertEquals(ran.paused, false);
  assertEquals(ran.sentCount, 1);
  assertEquals(sent, ["rec-1:curator"]);
  assertEquals(ran.outcomes[0].code, "sent");
  assertEquals(ran.outcomes[0].providerMessageId, "mid-rec-1");
});

Deno.test("auto-send: unknown terms still send; known paid does not", async () => {
  const unknown = candidate();
  assertEquals(unknown.decision.sendable, true);
  assertEquals(unknown.decision.warnings, ["terms_unconfirmed"]);
  const paid = candidate((row) => {
    row.target!.submission_cost = "paid";
  }, { handoffRecordId: "rec-paid", handle: "paidhandle", trackId: "track-paid" });
  assertEquals(paid.decision.sendable, false);
  assertEquals(paid.decision.blockers, ["terms_paid"]);
  const { transport, sent } = recordingTransport();
  const ran = await runIgCuratorDispatch({
    enabled: true,
    dailyCap: 10,
    now: NOW,
    candidates: [unknown, paid],
    claims: memoryClaimStore(NOW),
    transport,
  });
  assertEquals(sent, ["rec-1:curator"]);
  assertEquals(ran.outcomes.find((row) => row.handoffRecordId === "rec-paid")?.code, "terms_paid");
});

Deno.test("auto-send: double-dispatch sends a handle and song only once", async () => {
  const claims = memoryClaimStore(NOW);
  const { transport, sent } = recordingTransport();
  const row = candidate();
  const [first, second] = await Promise.all([
    runIgCuratorDispatch({ enabled: true, dailyCap: 10, now: NOW, candidates: [row], claims, transport }),
    runIgCuratorDispatch({ enabled: true, dailyCap: 10, now: NOW, candidates: [row], claims, transport }),
  ]);
  assertEquals(sent.length, 1);
  assertEquals(first.sentCount + second.sentCount, 1);
  const codes = [...first.outcomes, ...second.outcomes].map((item) => item.code).sort();
  assertEquals(codes, ["duplicate", "sent"]);
});

Deno.test("auto-send: kill switch sends nothing and does not claim", async () => {
  const claims = memoryClaimStore(NOW);
  const { transport, sent } = recordingTransport();
  const ran = await runIgCuratorDispatch({
    enabled: false,
    dailyCap: 10,
    now: NOW,
    candidates: [candidate()],
    claims,
    transport,
  });
  assertEquals(ran.paused, true);
  assertEquals(ran.sentCount, 0);
  assertEquals(sent, []);
  assertEquals(ran.outcomes[0].code, "kill_switch");
  assertEquals(claims.rows.size, 0);
});

Deno.test("auto-send: daily cap stops the second song", async () => {
  const { transport, sent } = recordingTransport();
  const first = candidate();
  const second = candidate(undefined, {
    handoffRecordId: "rec-2",
    trackId: "track-2",
    handle: "other",
  });
  const ran = await runIgCuratorDispatch({
    enabled: true,
    dailyCap: 1,
    now: NOW,
    candidates: [first, second],
    claims: memoryClaimStore(NOW),
    transport,
  });
  assertEquals(sent, ["rec-1:curator"]);
  assertEquals(ran.outcomes.map((row) => row.code), ["sent", "cap"]);
});

Deno.test("auto-send: opted-out and prior receipts are not sent", async () => {
  const { transport, sent } = recordingTransport();
  const ran = await runIgCuratorDispatch({
    enabled: true,
    dailyCap: 10,
    now: NOW,
    candidates: [
      candidate(undefined, { optedOut: true }),
      candidate(undefined, { handoffRecordId: "rec-old", trackId: "track-old", handle: "old", priorReceipt: true }),
    ],
    claims: memoryClaimStore(NOW),
    transport,
  });
  assertEquals(sent, []);
  assertEquals(ran.outcomes.map((row) => row.code), ["opted_out", "already_receipted"]);
});

Deno.test("auto-send env: switch defaults off and cap defaults to 10", () => {
  const env = { get: (name: string) => name === "IG_CURATOR_DAILY_CAP" ? "4" : undefined };
  assertEquals(igCuratorSendEnabled(env), false);
  assertEquals(igCuratorSendEnabled({ get: (name: string) => name === "IG_CURATOR_SEND_ENABLED" ? "true" : undefined }), true);
  assertEquals(igCuratorSendEnabled({ get: () => "false" }), false);
  assertEquals(igCuratorDailyCap({ get: () => undefined }), 10);
  assertEquals(igCuratorDailyCap(env), 4);
});

Deno.test("graph transport refuses a username with no IGSID before any network call", () => {
  const prepared = graphDmPrepare({
    handle: "curator",
    body: "hello",
    recipientId: null,
    handoffRecordId: "rec-1",
  }, "token");
  assertEquals(prepared.ok, false);
  if (!prepared.ok) assertEquals(prepared.code, "meta_cold_dm_unsupported");
});

Deno.test("scheduler, Grok and Fendi may dispatch; Muse and discovery may not", () => {
  assertEquals(capabilitiesFor("scheduler").has("dispatch_ig_curator_sends"), true);
  assertEquals(capabilitiesFor("grok_playlist_control").has("dispatch_ig_curator_sends"), true);
  assertEquals(capabilitiesFor("fendi").has("dispatch_ig_curator_sends"), true);
  assertEquals(capabilitiesFor("muse_ig_receipt").has("dispatch_ig_curator_sends"), false);
  assertEquals(capabilitiesFor("claude_playlist_discovery").has("dispatch_ig_curator_sends"), false);
  assertEquals(capabilitiesFor("scheduler").has("send_playlist_pitches"), false);
});
