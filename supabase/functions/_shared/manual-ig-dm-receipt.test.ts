/**
 * mark_manual_ig_dm_submitted follows the receipt onto the playlist target and
 * the matching approved Instagram draft. The pitch_log row itself is written by
 * the manual-submission trigger when submitted_at is first stamped; this suite
 * simulates that trigger in the stub.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chooseManualIgDraft,
  igReceiptTargetPatch,
  isAttributionHeldDraft,
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
  assertEquals(
    sb._writes.some((w: { table: string }) => w.table === "agh_handoff_records"),
    false,
  );
});
