/**
 * mark_manual_ig_dm_submitted and mark_manual_form_submitted follow the receipt
 * onto the handoff (queue_state SENT, submitted_at / submitted_by) and, for IG,
 * the playlist target plus the matching approved Instagram draft. The pitch_log
 * row itself is written by the manual-submission trigger when submitted_at is
 * first stamped; this suite simulates that trigger in the stub. SENT is a
 * second write so the trigger still sees APPROVED_FOR_SEND.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chooseManualIgDraft,
  igReceiptTargetPatch,
  isAttributionHeldDraft,
  manualReceiptSentTransition,
  markManualFormSubmitted,
  markManualIgDmSubmitted,
} from "./handoff-queues.ts";
import { resolveOpsActor } from "./ops-actors.ts";

type Row = Record<string, unknown>;

const TRACK_ID = "track-rap";
const PLAYLIST_ID = "pl-rap";
const DNA_ID = "dna-rap";
const RECEIPT_AT = "2026-08-15T18:30:00.000Z";

function evidence(at = RECEIPT_AT) {
  return {
    result: "submitted",
    reference: "ig-dm-thread-8841",
    notes: "Sent the approved DM from the operator account.",
    submitted_at: at,
  };
}

function grokActor() {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  return resolveOpsActor(
    null,
    new Request("https://example.test/", {
      method: "POST",
      headers: { "x-grok-playlist-control-secret": "grok-secret" },
    }),
  );
}

function packetObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** In-memory client. The first handoff submitted_at stamp also writes the receipt pitch_log, as the DB trigger does. */
function stubSb(tables: Record<string, Row[]>) {
  const writes: { table: string; op: string; row: Row }[] = [];
  let pitchSeq = 1;
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let mode: "select" | "update" = "select";
      let patch: Row = {};
      const matched = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const applyUpdate = () => {
        const hit = matched();
        for (const row of hit) {
          const beforeSubmitted = row.submitted_at;
          Object.assign(row, patch);
          if (
            table === "agh_handoff_records" &&
            patch.submitted_at != null &&
            (beforeSubmitted == null || String(beforeSubmitted).trim() === "")
          ) {
            const id = `pitch-log-${pitchSeq++}`;
            const packet = packetObject(row.packet);
            row.packet = {
              ...packet,
              submission_receipt: { pitch_log_id: id },
            };
            (tables.pitch_log ??= []).push({
              id,
              playlist_id: row.playlist_target_id,
              track_id: row.track_id,
              method: row.manual_submit_channel,
              status: "sent",
              sent_at: row.submitted_at,
              pitched_at: row.submitted_at,
            });
            (tables.agh_manual_submission_receipts ??= []).push({
              handoff_record_id: row.id,
              pitch_log_id: id,
            });
          }
        }
        writes.push({ table, op: "update", row: { ...patch } });
        return hit;
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters.push((r) => String(r[k] ?? "") === String(v ?? ""));
          return chain;
        },
        in: (k: string, vals: unknown[]) => {
          const set = new Set((vals ?? []).map((v) => String(v)));
          filters.push((r) => set.has(String(r[k] ?? "")));
          return chain;
        },
        not: () => chain,
        ilike: (k: string, v: unknown) => {
          filters.push((r) => String(r[k] ?? "").toLowerCase() === String(v ?? "").toLowerCase());
          return chain;
        },
        is: (k: string, v: unknown) => {
          if (v === null) filters.push((r) => r[k] == null || String(r[k]).trim() === "");
          else filters.push((r) => String(r[k] ?? "") === String(v));
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        update: (p: Row) => {
          mode = "update";
          patch = p;
          return chain;
        },
        insert: (p: Row) => {
          (tables[table] ??= []).push(p);
          writes.push({ table, op: "insert", row: p });
          // deno-lint-ignore no-explicit-any
          const inserted: any = {
            select: () => inserted,
            maybeSingle: () => Promise.resolve({ data: p, error: null }),
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: p, error: null })),
          };
          return inserted;
        },
        maybeSingle: () => {
          if (mode === "update") return Promise.resolve({ data: applyUpdate()[0] ?? null, error: null });
          return Promise.resolve({ data: matched()[0] ?? null, error: null });
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (mode === "update") {
            applyUpdate();
            return Promise.resolve(resolve({ data: null, error: null }));
          }
          return Promise.resolve(resolve({ data: matched(), error: null }));
        },
      };
      return chain;
    },
    _writes: writes,
    _tables: tables,
  };
  return sb;
}

function baseTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    tracks: [{
      id: TRACK_ID,
      name: "Control",
      short_pitch: "legacy pitch must not authorize",
      pitch_angle: "legacy angle",
      approved_song_dna_version_id: DNA_ID,
    }],
    song_dna_versions: [{
      id: DNA_ID,
      track_id: TRACK_ID,
      short_pitch: "A late-night rap record.",
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["house_club"],
      primary_genre: "rap",
    }],
    playlist_targets: [{
      playlist_id: PLAYLIST_ID,
      playlist_name: "Rap Night",
      curator_name: "C",
      lane: "rap_general",
      verification_status: "auto_verified",
      path_verified: true,
      is_active: true,
      contact_method: "instagram_dm",
      ig_curator_account: "rapcurator",
      ig_source_evidence: "IG bio says DM for playlist submissions",
      pitch_status: "not_pitched",
      last_pitched_at: null,
    }],
    agh_handoff_records: [{
      id: "rec-ig",
      queue_state: "APPROVED_FOR_SEND",
      track_id: TRACK_ID,
      playlist_target_id: PLAYLIST_ID,
      submission_channel: "instagram_dm",
      song_dna_version_id: DNA_ID,
      packet: {},
    }],
    outreach_drafts: [],
    pitch_log: [],
    agh_manual_submission_receipts: [],
    artist_config: [
      { key: "lanes", value: {} },
      { key: "cooldown_days", value: 90 },
    ],
    outreach_decision_shadow_log: [],
    ...extra,
  };
}

function draft(partial: Row): Row {
  return {
    track_id: TRACK_ID,
    playlist_id: PLAYLIST_ID,
    channel: "instagram_dm",
    status: "approved",
    generated_by: "claude_playlist_discovery",
    sent_at: null,
    pitch_log_id: null,
    metadata: {},
    created_at: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

Deno.test("receipt target patch uses the receipt time and never downgrades a later status", () => {
  const first = igReceiptTargetPatch({
    pitchStatus: "not_pitched",
    lastPitchedAt: null,
    igManualSubmittedAt: null,
    submittedAt: RECEIPT_AT,
    result: "submitted",
    actorLabel: "grok_playlist_control",
    replay: false,
  });
  assertEquals(first?.pitch_status, "pitched");
  assertEquals(first?.last_pitched_at, RECEIPT_AT);
  assertEquals(first?.ig_manual_submitted_at, RECEIPT_AT);

  const alreadyPitched = igReceiptTargetPatch({
    pitchStatus: "pitched",
    lastPitchedAt: "2026-07-01T00:00:00.000Z",
    igManualSubmittedAt: null,
    submittedAt: RECEIPT_AT,
    result: "submitted",
    actorLabel: "grok_playlist_control",
    replay: false,
  });
  assertEquals(alreadyPitched?.pitch_status, "pitched");
  assertEquals(alreadyPitched?.last_pitched_at, RECEIPT_AT);

  for (const status of ["replied", "placed", "declined", "pay_to_play", "paid", "inactive", "Replied"]) {
    const kept = igReceiptTargetPatch({
      pitchStatus: status,
      lastPitchedAt: "2026-07-01T00:00:00.000Z",
      igManualSubmittedAt: null,
      submittedAt: RECEIPT_AT,
      result: "submitted",
      actorLabel: "grok_playlist_control",
      replay: false,
    });
    assertEquals(kept?.pitch_status, undefined, status);
    assertEquals(kept?.last_pitched_at, undefined, status);
    assertEquals(kept?.ig_manual_submitted_at, RECEIPT_AT, status);
  }

  const replay = igReceiptTargetPatch({
    pitchStatus: "pitched",
    lastPitchedAt: RECEIPT_AT,
    igManualSubmittedAt: RECEIPT_AT,
    submittedAt: "2026-09-01T00:00:00.000Z",
    result: "submitted",
    actorLabel: "grok_playlist_control",
    replay: true,
  });
  assertEquals(replay, null);

  const replayGap = igReceiptTargetPatch({
    pitchStatus: "not_pitched",
    lastPitchedAt: "2026-07-01T00:00:00.000Z",
    igManualSubmittedAt: RECEIPT_AT,
    submittedAt: RECEIPT_AT,
    result: "submitted",
    actorLabel: "grok_playlist_control",
    replay: true,
  });
  assertEquals(replayGap?.pitch_status, "pitched");
  assertEquals(replayGap?.last_pitched_at, undefined);
});

Deno.test("draft choice prefers the handoff and leaves attribution-held drafts alone", () => {
  assertEquals(isAttributionHeldDraft({ generated_by: "fendi" }), true);
  assertEquals(isAttributionHeldDraft({ generated_by: "claude", drafted_by: "fendi" }), true);
  assertEquals(isAttributionHeldDraft({ generated_by: "claude", metadata: { drafted_by: "Fendi" } }), true);
  assertEquals(isAttributionHeldDraft({ generated_by: "claude_playlist_discovery" }), false);

  const older = draft({ id: "older", created_at: "2026-08-01T00:00:00.000Z" });
  const match = draft({
    id: "match",
    created_at: "2026-08-02T00:00:00.000Z",
    metadata: { handoff_record_id: "rec-ig" },
  });
  assertEquals(chooseManualIgDraft([older, match], "rec-ig").draft?.id, "match");

  const heldMatch = draft({
    id: "held",
    generated_by: "fendi",
    metadata: { handoff_record_id: "rec-ig" },
  });
  const other = draft({ id: "other" });
  assertEquals(chooseManualIgDraft([heldMatch, other], "rec-ig"), {
    draft: null,
    skipped: "attribution_held",
  });

  const heldOther = draft({ id: "held-other", drafted_by: "fendi" });
  const open = draft({ id: "open", created_at: "2026-08-03T00:00:00.000Z" });
  assertEquals(chooseManualIgDraft([heldOther, open], "rec-ig").draft?.id, "open");
});

Deno.test("manual IG receipt stamps the target and the handoff draft at the receipt time", async () => {
  const tables = baseTables({
    outreach_drafts: [
      draft({ id: "draft-older", created_at: "2026-08-01T00:00:00.000Z" }),
      draft({
        id: "draft-match",
        created_at: "2026-08-02T00:00:00.000Z",
        metadata: { handoff_record_id: "rec-ig" },
      }),
      draft({ id: "draft-email", channel: "email" }),
      draft({ id: "draft-pending", status: "pending" }),
      draft({ id: "draft-held", generated_by: "fendi", metadata: { handoff_record_id: "rec-other" } }),
    ],
  });
  const sb = stubSb(tables);
  const res = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence() },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.pitch_log_id, "pitch-log-1");
  assertEquals(res.data.target_pitch_status, "pitched");
  assertEquals(res.data.target_status_preserved, false);
  assertEquals(res.data.outreach_draft_id, "draft-match");
  assertEquals(res.data.queue_state, "SENT");
  assertEquals(res.data.queue_state_updated, true);

  const target = tables.playlist_targets[0];
  assertEquals(target.pitch_status, "pitched");
  assertEquals(target.last_pitched_at, RECEIPT_AT);
  assertEquals(target.ig_manual_submitted_at, RECEIPT_AT);
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.pitch_log[0].sent_at, RECEIPT_AT);
  assertEquals(tables.pitch_log[0].pitched_at, RECEIPT_AT);

  const byId = new Map(tables.outreach_drafts.map((d) => [d.id, d]));
  assertEquals(byId.get("draft-match")?.status, "sent");
  assertEquals(byId.get("draft-match")?.sent_at, RECEIPT_AT);
  assertEquals(byId.get("draft-match")?.pitch_log_id, "pitch-log-1");
  assertEquals(byId.get("draft-older")?.status, "approved");
  assertEquals(byId.get("draft-older")?.sent_at, null);
  assertEquals(byId.get("draft-email")?.status, "approved");
  assertEquals(byId.get("draft-pending")?.status, "pending");
  assertEquals(byId.get("draft-held")?.status, "approved");
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");

  const handoffWrites = sb._writes.filter((w: { table: string }) => w.table === "agh_handoff_records");
  assertEquals(handoffWrites.length, 2);
  assertEquals(handoffWrites[0].row.submitted_at, RECEIPT_AT);
  assertEquals(handoffWrites[0].row.queue_state, undefined);
  assertEquals(handoffWrites[1].row.queue_state, "SENT");
  assertEquals(handoffWrites[1].row.submitted_at, undefined);
  assertEquals(handoffWrites[1].row.submitted_by, undefined);
});

Deno.test("manual IG receipt does not downgrade a later target status", async () => {
  const tables = baseTables({
    outreach_drafts: [draft({ id: "draft-match", metadata: { handoff_record_id: "rec-ig" } })],
  });
  tables.playlist_targets[0].pitch_status = "replied";
  tables.playlist_targets[0].last_pitched_at = "2026-07-01T00:00:00.000Z";
  const sb = stubSb(tables);
  const res = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence() },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.target_status_preserved, true);
  assertEquals(tables.playlist_targets[0].pitch_status, "replied");
  assertEquals(tables.playlist_targets[0].last_pitched_at, "2026-07-01T00:00:00.000Z");
  assertEquals(tables.playlist_targets[0].ig_manual_submitted_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].status, "sent");
  assertEquals(tables.outreach_drafts[0].sent_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
});

Deno.test("manual IG receipt leaves an attribution-held handoff draft approved", async () => {
  const tables = baseTables({
    outreach_drafts: [
      draft({
        id: "draft-held",
        generated_by: "fendi",
        metadata: { handoff_record_id: "rec-ig" },
      }),
      draft({ id: "draft-other", created_at: "2026-08-01T00:00:00.000Z" }),
    ],
  });
  const sb = stubSb(tables);
  const res = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence() },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.outreach_draft_skipped, "attribution_held");
  assertEquals(res.data.outreach_draft_id, null);
  assertEquals(tables.outreach_drafts.every((d) => d.status === "approved"), true);
  assertEquals(tables.playlist_targets[0].pitch_status, "pitched");
  assertEquals(tables.playlist_targets[0].last_pitched_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(sb._writes.filter((w: { table: string }) => w.table === "outreach_drafts"), []);
});

Deno.test("re-running the same IG receipt does not duplicate the pitch or move timestamps", async () => {
  const tables = baseTables({
    outreach_drafts: [draft({ id: "draft-match", metadata: { handoff_record_id: "rec-ig" } })],
  });
  const sb = stubSb(tables);
  const ops = grokActor();
  const first = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence() },
    ops,
  );
  assertEquals(first.status, 200, JSON.stringify(first.data));
  sb._writes.length = 0;

  const second = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence("2026-08-20T12:00:00.000Z") },
    ops,
  );
  assertEquals(second.status, 200, JSON.stringify(second.data));
  assertEquals(second.data.idempotent, true);
  assertEquals(second.data.noop, true);
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.playlist_targets[0].last_pitched_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].sent_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].pitch_log_id, "pitch-log-1");
  assertEquals(sb._writes.filter((w: { op: string }) => w.op === "update"), []);
});

Deno.test("re-running a receipt fills a target and draft the first stamp left behind", async () => {
  const tables = baseTables({
    agh_handoff_records: [{
      id: "rec-ig",
      queue_state: "APPROVED_FOR_SEND",
      track_id: TRACK_ID,
      playlist_target_id: PLAYLIST_ID,
      submission_channel: "instagram_dm",
      song_dna_version_id: DNA_ID,
      submitted_at: RECEIPT_AT,
      submitted_by: "grok_playlist_control",
      submitted_by_label: "grok_playlist_control",
      manual_submit_result: "submitted",
      packet: { submission_receipt: { pitch_log_id: "pitch-log-existing" } },
    }],
    outreach_drafts: [draft({
      id: "draft-match",
      metadata: { handoff_record_id: "rec-ig", drafted_by: "claude" },
    })],
    pitch_log: [{ id: "pitch-log-existing", sent_at: RECEIPT_AT, pitched_at: RECEIPT_AT }],
  });
  const sb = stubSb(tables);
  const res = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence("2026-08-20T12:00:00.000Z") },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.idempotent, true);
  assertEquals(res.data.noop, false);
  assertEquals(res.data.repaired, true);
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.playlist_targets[0].pitch_status, "pitched");
  assertEquals(tables.playlist_targets[0].last_pitched_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].status, "sent");
  assertEquals(tables.outreach_drafts[0].sent_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].pitch_log_id, "pitch-log-existing");
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  const handoffWrites = sb._writes.filter((w: { table: string }) => w.table === "agh_handoff_records");
  assertEquals(handoffWrites.length, 1);
  assertEquals(handoffWrites[0].row.queue_state, "SENT");
  assertEquals(handoffWrites[0].row.submitted_at, undefined);
  assertEquals(handoffWrites[0].row.submitted_by, undefined);
});

Deno.test("manual receipt queue move is SENT only from APPROVED_FOR_SEND", () => {
  assertEquals(manualReceiptSentTransition("APPROVED_FOR_SEND"), "SENT");
  for (const state of ["SENT", "AWAITING_AGH_IMPORT", "IMPORTED_TO_AGH", "REJECTED_BY_GROK", "GROK_REVIEWED"]) {
    assertEquals(manualReceiptSentTransition(state), null, state);
  }
});

Deno.test("IG replay fills a leftover APPROVED_FOR_SEND without moving stored timestamps", async () => {
  const tables = baseTables({
    agh_handoff_records: [{
      id: "rec-ig",
      queue_state: "APPROVED_FOR_SEND",
      track_id: TRACK_ID,
      playlist_target_id: PLAYLIST_ID,
      submission_channel: "instagram_dm",
      song_dna_version_id: DNA_ID,
      submitted_at: RECEIPT_AT,
      submitted_by: "grok_playlist_control",
      submitted_by_label: "grok_playlist_control",
      manual_submit_result: "submitted",
      packet: { submission_receipt: { pitch_log_id: "pitch-log-existing" } },
    }],
    outreach_drafts: [draft({
      id: "draft-match",
      status: "sent",
      sent_at: RECEIPT_AT,
      pitch_log_id: "pitch-log-existing",
      metadata: { handoff_record_id: "rec-ig" },
    })],
    pitch_log: [{ id: "pitch-log-existing", sent_at: RECEIPT_AT, pitched_at: RECEIPT_AT }],
  });
  tables.playlist_targets[0].pitch_status = "pitched";
  tables.playlist_targets[0].last_pitched_at = RECEIPT_AT;
  tables.playlist_targets[0].ig_manual_submitted_at = RECEIPT_AT;
  const sb = stubSb(tables);
  const res = await markManualIgDmSubmitted(
    sb,
    { handoff_record_id: "rec-ig", evidence: evidence("2026-08-20T12:00:00.000Z") },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.idempotent, true);
  assertEquals(res.data.noop, false);
  assertEquals(res.data.queue_state_updated, true);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.playlist_targets[0].last_pitched_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].sent_at, RECEIPT_AT);
  assertEquals(sb._writes.filter((w: { table: string }) => w.table === "outreach_drafts"), []);
  assertEquals(sb._writes.filter((w: { table: string }) => w.table === "playlist_targets"), []);
});

Deno.test("IG replay does not downgrade a handoff already past SENT", async () => {
  for (const state of ["AWAITING_AGH_IMPORT", "IMPORTED_TO_AGH"]) {
    const tables = baseTables({
      agh_handoff_records: [{
        id: "rec-ig",
        queue_state: state,
        track_id: TRACK_ID,
        playlist_target_id: PLAYLIST_ID,
        submission_channel: "instagram_dm",
        song_dna_version_id: DNA_ID,
        submitted_at: RECEIPT_AT,
        submitted_by: "fendi",
        submitted_by_label: "fendi",
        manual_submit_result: "submitted",
        packet: { submission_receipt: { pitch_log_id: "pitch-log-existing" } },
      }],
      outreach_drafts: [draft({
        id: "draft-held",
        generated_by: "fendi",
        metadata: { handoff_record_id: "rec-ig" },
      })],
      pitch_log: [{ id: "pitch-log-existing", sent_at: RECEIPT_AT, pitched_at: RECEIPT_AT }],
    });
    tables.playlist_targets[0].pitch_status = "replied";
    tables.playlist_targets[0].last_pitched_at = "2026-07-01T00:00:00.000Z";
    const sb = stubSb(tables);
    const res = await markManualIgDmSubmitted(
      sb,
      { handoff_record_id: "rec-ig", evidence: evidence("2026-08-20T12:00:00.000Z") },
      grokActor(),
    );
    assertEquals(res.status, 200, `${state} ${JSON.stringify(res.data)}`);
    assertEquals(res.data.idempotent, true, state);
    assertEquals(res.data.queue_state_updated, false, state);
    assertEquals(tables.agh_handoff_records[0].queue_state, state);
    assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
    assertEquals(tables.agh_handoff_records[0].submitted_by, "fendi");
    assertEquals(tables.pitch_log.length, 1, state);
    assertEquals(tables.playlist_targets[0].pitch_status, "replied", state);
    assertEquals(tables.playlist_targets[0].last_pitched_at, "2026-07-01T00:00:00.000Z", state);
    assertEquals(tables.outreach_drafts[0].status, "approved", state);
    assertEquals(tables.outreach_drafts[0].generated_by, "fendi", state);
    assertEquals(sb._writes.filter((w: { table: string }) => w.table === "agh_handoff_records"), [], state);
    assertEquals(sb._writes.filter((w: { table: string }) => w.table === "outreach_drafts"), [], state);
  }
});

function webFormTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  const tables = baseTables(extra);
  tables.playlist_targets[0] = {
    ...tables.playlist_targets[0],
    contact_method: "web_form",
    form_url: "https://forms.gle/AbC123",
    form_source_evidence: "curator bio links a submission form",
    ig_curator_account: null,
    ig_source_evidence: null,
  };
  if (!extra.agh_handoff_records) {
    tables.agh_handoff_records[0] = {
      ...tables.agh_handoff_records[0],
      id: "rec-form",
      submission_channel: "web_form",
    };
  }
  return tables;
}

Deno.test("manual web form receipt sets SENT and the backdated receipt in the same call", async () => {
  const tables = webFormTables({
    outreach_drafts: [
      draft({ id: "draft-held", generated_by: "fendi", channel: "web_form", metadata: { handoff_record_id: "rec-form" } }),
    ],
  });
  const sb = stubSb(tables);
  const res = await markManualFormSubmitted(
    sb,
    { handoff_record_id: "rec-form", evidence: evidence() },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.queue_state, "SENT");
  assertEquals(res.data.queue_state_updated, true);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  assertEquals(tables.agh_handoff_records[0].submitted_by_label, "grok_playlist_control");
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.pitch_log[0].sent_at, RECEIPT_AT);
  assertEquals(tables.pitch_log[0].method, "web_form");
  assertEquals(tables.playlist_targets[0].form_manual_submitted_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].status, "approved");
  assertEquals(tables.outreach_drafts[0].generated_by, "fendi");
  assertEquals(sb._writes.filter((w: { table: string }) => w.table === "outreach_drafts"), []);

  const handoffWrites = sb._writes.filter((w: { table: string }) => w.table === "agh_handoff_records");
  assertEquals(handoffWrites.length, 2);
  assertEquals(handoffWrites[0].row.submitted_at, RECEIPT_AT);
  assertEquals(handoffWrites[0].row.queue_state, undefined);
  assertEquals(handoffWrites[1].row.queue_state, "SENT");
  assertEquals(handoffWrites[1].row.submitted_at, undefined);

  sb._writes.length = 0;
  const replay = await markManualFormSubmitted(
    sb,
    { handoff_record_id: "rec-form", evidence: evidence("2026-08-20T12:00:00.000Z") },
    grokActor(),
  );
  assertEquals(replay.status, 200, JSON.stringify(replay.data));
  assertEquals(replay.data.idempotent, true);
  assertEquals(replay.data.noop, true);
  assertEquals(tables.pitch_log.length, 1);
  assertEquals(tables.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(tables.agh_handoff_records[0].submitted_by, "grok_playlist_control");
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.playlist_targets[0].form_manual_submitted_at, RECEIPT_AT);
  assertEquals(tables.outreach_drafts[0].status, "approved");
  assertEquals(sb._writes.filter((w: { op: string }) => w.op === "update"), []);
});

Deno.test("web form replay fills a leftover APPROVED_FOR_SEND and leaves a later status", async () => {
  const behind = webFormTables({
    agh_handoff_records: [{
      id: "rec-form",
      queue_state: "APPROVED_FOR_SEND",
      track_id: TRACK_ID,
      playlist_target_id: PLAYLIST_ID,
      submission_channel: "web_form",
      song_dna_version_id: DNA_ID,
      submitted_at: RECEIPT_AT,
      submitted_by: "grok_playlist_control",
      submitted_by_label: "grok_playlist_control",
      packet: { submission_receipt: { pitch_log_id: "pitch-log-existing" } },
    }],
    pitch_log: [{ id: "pitch-log-existing", method: "web_form", sent_at: RECEIPT_AT }],
    outreach_drafts: [draft({ id: "draft-held", generated_by: "fendi", channel: "web_form" })],
  });
  behind.playlist_targets[0].form_manual_submitted_at = RECEIPT_AT;
  const sb = stubSb(behind);
  const res = await markManualFormSubmitted(
    sb,
    { handoff_record_id: "rec-form", evidence: evidence("2026-08-20T12:00:00.000Z") },
    grokActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.queue_state_updated, true);
  assertEquals(behind.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(behind.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(behind.pitch_log.length, 1);
  assertEquals(behind.playlist_targets[0].form_manual_submitted_at, RECEIPT_AT);
  assertEquals(behind.outreach_drafts[0].status, "approved");

  const later = webFormTables({
    agh_handoff_records: [{
      id: "rec-form",
      queue_state: "IMPORTED_TO_AGH",
      track_id: TRACK_ID,
      playlist_target_id: PLAYLIST_ID,
      submission_channel: "web_form",
      song_dna_version_id: DNA_ID,
      submitted_at: RECEIPT_AT,
      submitted_by: "fendi",
      submitted_by_label: "fendi",
      packet: { submission_receipt: { pitch_log_id: "pitch-log-existing" } },
    }],
    pitch_log: [{ id: "pitch-log-existing" }],
  });
  const laterSb = stubSb(later);
  const kept = await markManualFormSubmitted(
    laterSb,
    { handoff_record_id: "rec-form", evidence: evidence("2026-08-20T12:00:00.000Z") },
    grokActor(),
  );
  assertEquals(kept.status, 200, JSON.stringify(kept.data));
  assertEquals(kept.data.noop, true);
  assertEquals(kept.data.queue_state_updated, false);
  assertEquals(later.agh_handoff_records[0].queue_state, "IMPORTED_TO_AGH");
  assertEquals(later.agh_handoff_records[0].submitted_at, RECEIPT_AT);
  assertEquals(later.agh_handoff_records[0].submitted_by, "fendi");
  assertEquals(later.pitch_log.length, 1);
  assertEquals(laterSb._writes.filter((w: { op: string }) => w.op === "update"), []);
});
