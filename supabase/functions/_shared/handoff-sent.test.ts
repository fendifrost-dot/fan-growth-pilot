import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { markLinkedHandoffEmailBounced, markLinkedHandoffEmailSent } from "./handoff-sent.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>) {
  const updates: { id: string; row: Row }[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const addIn = (k: string, vals: unknown[]) => {
        const allowed = new Set((Array.isArray(vals) ? vals : []).map((v) => String(v ?? "")));
        filters.push((r) => allowed.has(String(r[k] ?? "")));
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k] ?? "") === String(v ?? "")), chain),
        in: (k: string, vals: unknown[]) => (addIn(k, vals), chain),
        update: (row: Row) => {
          // deno-lint-ignore no-explicit-any
          const write: any = {
            eq: (k: string, v: unknown) => (filters.push((r) => String(r[k] ?? "") === String(v ?? "")), write),
            in: (k: string, vals: unknown[]) => (addIn(k, vals), write),
            select: () => {
              const matched = rows();
              for (const hit of matched) {
                Object.assign(hit, row);
                updates.push({ id: String(hit.id), row: { ...row } });
              }
              return Promise.resolve({ data: matched.map((r) => ({ id: r.id })), error: null });
            },
          };
          return write;
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows(), error: null })),
      };
      return chain;
    },
  };
  return { sb, updates, tables };
}

const sentAt = "2026-10-13T15:26:00.000Z";

Deno.test("email send moves the linked approved handoff to SENT and leaves other channels", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_records: [
      {
        id: "email-1",
        outreach_draft_id: "draft-1",
        playlist_target_id: "pl-1",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        packet: { grok_review: { verdict: "PASS" } },
      },
      {
        id: "form-1",
        outreach_draft_id: "draft-1",
        playlist_target_id: "pl-1",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "web_form",
        packet: {},
      },
    ],
  });
  const res = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-1",
    playlistId: "pl-1",
    trackId: "track-1",
    pitchLogId: "log-1",
    resendMessageId: "re_123",
    sentAt,
  });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["email-1"]);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(
    (tables.agh_handoff_records[0].packet as Row).email_dispatch,
    {
      pitch_log_id: "log-1",
      resend_message_id: "re_123",
      sent_at: sentAt,
      channel: "email",
      outcome: "sent",
      prior_queue_state: "APPROVED_FOR_SEND",
    },
  );
  assertEquals((tables.agh_handoff_records[0].packet as Row).grok_review, { verdict: "PASS" });
  assertEquals(tables.agh_handoff_records[0].submitted_at, undefined);
  assertEquals(tables.agh_handoff_records[1].queue_state, "APPROVED_FOR_SEND");
});

Deno.test("a send without a Resend id does not move the handoff", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_records: [{
      id: "email-1",
      outreach_draft_id: "draft-1",
      queue_state: "APPROVED_FOR_SEND",
      submission_channel: "email",
      packet: {},
    }],
  });
  const res = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-1",
    playlistId: "pl-1",
    trackId: "track-1",
    pitchLogId: "log-1",
    resendMessageId: null,
    sentAt,
  });
  assertEquals(res.updated_ids, []);
  assertEquals(tables.agh_handoff_records[0].queue_state, "APPROVED_FOR_SEND");
});

Deno.test("approve-and-send advances review and imported email handoffs and leaves the rest", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_records: [
      { id: "review", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "email", packet: {} },
      { id: "grok", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "GROK_REVIEWED", submission_channel: "email", packet: {} },
      { id: "imported", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "IMPORTED_TO_AGH", submission_channel: "email", packet: {} },
      { id: "waiting", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "AWAITING_AGH_IMPORT", submission_channel: "email", packet: {} },
      { id: "rejected", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "REJECTED_BY_GROK", submission_channel: "email", packet: {} },
      { id: "ig", outreach_draft_id: "draft-1", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "instagram_dm", packet: {} },
      { id: "other-review", outreach_draft_id: "other-draft", playlist_target_id: "pl-1", track_id: "track-1", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "email", packet: {} },
    ],
    outreach_drafts: [{ id: "draft-1", generated_by: "grok" }, { id: "other-draft", generated_by: "auto" }],
  });
  const res = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-1",
    playlistId: "pl-1",
    trackId: "track-1",
    pitchLogId: "log-1",
    resendMessageId: "re_sent",
    sentAt,
  });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["review", "grok", "imported", "waiting"]);
  const byId = new Map(tables.agh_handoff_records.map((r) => [String(r.id), r]));
  const priorById: Record<string, string> = {
    review: "AWAITING_GROK_REVIEW",
    grok: "GROK_REVIEWED",
    imported: "IMPORTED_TO_AGH",
    waiting: "AWAITING_AGH_IMPORT",
  };
  for (const id of Object.keys(priorById)) {
    assertEquals(byId.get(id)!.queue_state, "SENT", id);
    assertEquals((byId.get(id)!.packet as Row).email_dispatch, {
      pitch_log_id: "log-1",
      resend_message_id: "re_sent",
      sent_at: sentAt,
      channel: "email",
      outcome: "sent",
      prior_queue_state: priorById[id],
    });
  }
  assertEquals(byId.get("rejected")!.queue_state, "REJECTED_BY_GROK");
  assertEquals(byId.get("ig")!.queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(byId.get("other-review")!.queue_state, "AWAITING_GROK_REVIEW");
});

Deno.test("a fendi draft and a Soundplate row are not moved on send", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_records: [
      { id: "fendi-row", outreach_draft_id: "fendi-draft", playlist_target_id: "pl-fendi", track_id: "track-1", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "email", packet: {} },
      { id: "plate-row", outreach_draft_id: "plate-draft", playlist_target_id: "pl-plate", track_id: "track-1", queue_state: "IMPORTED_TO_AGH", submission_channel: "email", packet: {} },
    ],
    outreach_drafts: [
      { id: "fendi-draft", generated_by: "fendi" },
      { id: "plate-draft", generated_by: "auto" },
    ],
    playlist_targets: [
      { playlist_id: "pl-plate", form_url: "https://play.soundplate.com/drift", submission_method: "soundplate" },
    ],
  });
  const fendi = await markLinkedHandoffEmailSent(sb, {
    draftId: "fendi-draft",
    playlistId: "pl-fendi",
    trackId: "track-1",
    pitchLogId: "log-f",
    resendMessageId: "re_fendi",
    sentAt,
  });
  assertEquals(fendi.updated_ids, []);
  assertEquals(tables.agh_handoff_records[0].queue_state, "AWAITING_GROK_REVIEW");
  const plate = await markLinkedHandoffEmailSent(sb, {
    draftId: "plate-draft",
    playlistId: "pl-plate",
    trackId: "track-1",
    pitchLogId: "log-p",
    resendMessageId: "re_plate",
    sentAt,
  });
  assertEquals(plate.updated_ids, []);
  assertEquals(tables.agh_handoff_records[1].queue_state, "IMPORTED_TO_AGH");
  assertEquals((tables.agh_handoff_records[1].packet as Row).email_dispatch, undefined);
});

Deno.test("a Soundplate URL stored only on the playlist target does not block an email send", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_records: [
      {
        id: "email-url",
        outreach_draft_id: "draft-url",
        playlist_target_id: "pl-url",
        track_id: "track-1",
        queue_state: "AWAITING_GROK_REVIEW",
        submission_channel: "email",
        packet: { outreach_draft_id: "draft-url" },
      },
      {
        id: "packet-url",
        outreach_draft_id: "draft-packet",
        playlist_target_id: "pl-packet",
        track_id: "track-1",
        queue_state: "AWAITING_GROK_REVIEW",
        submission_channel: "email",
        packet: { form_url: "https://play.soundplate.com/packet" },
      },
    ],
    outreach_drafts: [
      { id: "draft-url", generated_by: "claude_playlist_discovery" },
      { id: "draft-packet", generated_by: "claude_playlist_discovery" },
    ],
    playlist_targets: [
      {
        playlist_id: "pl-url",
        form_url: "https://play.soundplate.com/dhach",
        submission_url: "https://play.soundplate.com/dhach",
        curator_website: null,
        submission_method: "email",
      },
      { playlist_id: "pl-packet", form_url: "https://forms.example.test/submit", submission_method: "email" },
    ],
  });
  const sent = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-url",
    playlistId: "pl-url",
    trackId: "track-1",
    pitchLogId: "log-url",
    resendMessageId: "re_url",
    sentAt,
  });
  assertEquals(sent.error, undefined);
  assertEquals(sent.updated_ids, ["email-url"]);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(tables.agh_handoff_records[0].submitted_at, undefined);
  assertEquals(((tables.agh_handoff_records[0].packet as Row).email_dispatch as Row).outcome, "sent");
  assertEquals(((tables.agh_handoff_records[0].packet as Row).email_dispatch as Row).prior_queue_state, "AWAITING_GROK_REVIEW");

  const packet = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-packet",
    playlistId: "pl-packet",
    trackId: "track-1",
    pitchLogId: "log-packet",
    resendMessageId: "re_packet",
    sentAt,
  });
  assertEquals(packet.updated_ids, []);
  assertEquals(tables.agh_handoff_records[1].queue_state, "AWAITING_GROK_REVIEW");
  assertEquals((tables.agh_handoff_records[1].packet as Row).email_dispatch, undefined);
});

Deno.test("a bounce on an email whose target only stores a Soundplate URL is recorded", async () => {
  const { sb, tables } = stubSb({
    pitch_log: [
      { id: "log-url-b", draft_id: "draft-url-b", status: "bounced", placement_status: "unknown", resend_message_id: "re_url_bounce" },
    ],
    outreach_drafts: [{ id: "draft-url-b", generated_by: "claude_playlist_discovery" }],
    playlist_targets: [
      { playlist_id: "pl-url", form_url: "https://play.soundplate.com/dhach", submission_url: "https://play.soundplate.com/dhach", submission_method: "email" },
    ],
    agh_handoff_records: [
      { id: "url-bounce", outreach_draft_id: "draft-url-b", playlist_target_id: "pl-url", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "email", packet: {} },
    ],
  });
  const res = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_url_bounce", bouncedAt: sentAt });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["url-bounce"]);
  assertEquals(tables.agh_handoff_records[0].queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(((tables.agh_handoff_records[0].packet as Row).email_dispatch as Row).outcome, "bounced");
});

Deno.test("a bounce is recorded and a false SENT is put back", async () => {
  const { sb, tables } = stubSb({
    pitch_log: [
      { id: "log-b", draft_id: "draft-b", status: "bounced", placement_status: "unknown", resend_message_id: "re_bounce" },
      { id: "log-s", draft_id: "draft-s", status: "bounced", placement_status: "bounced", resend_message_id: "re_was_sent" },
      { id: "log-f", draft_id: "fendi-draft", status: "bounced", resend_message_id: "re_fendi_bounce" },
      { id: "log-p", draft_id: "plate-draft", status: "sent", placement_status: "bounced", resend_message_id: "re_plate_bounce" },
    ],
    outreach_drafts: [
      { id: "draft-b", generated_by: "auto" },
      { id: "draft-s", generated_by: "grok" },
      { id: "fendi-draft", generated_by: "fendi" },
      { id: "plate-draft", generated_by: "auto" },
    ],
    playlist_targets: [
      { playlist_id: "pl-plate", form_url: "https://soundplate.com/submit-music/", submission_method: "soundplate" },
    ],
    agh_handoff_records: [
      { id: "still-review", outreach_draft_id: "draft-b", playlist_target_id: "pl-b", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "email", packet: {} },
      {
        id: "false-sent",
        outreach_draft_id: "draft-s",
        playlist_target_id: "pl-s",
        queue_state: "SENT",
        submission_channel: "email",
        packet: { email_dispatch: { outcome: "sent", prior_queue_state: "GROK_REVIEWED", resend_message_id: "re_was_sent", channel: "email" } },
      },
      { id: "fendi-row", outreach_draft_id: "fendi-draft", playlist_target_id: "pl-f", queue_state: "GROK_REVIEWED", submission_channel: "email", packet: {} },
      { id: "plate-row", outreach_draft_id: "plate-draft", playlist_target_id: "pl-plate", queue_state: "IMPORTED_TO_AGH", submission_channel: "email", packet: {} },
    ],
  });
  const review = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_bounce", bouncedAt: sentAt });
  assertEquals(review.error, undefined);
  assertEquals(review.updated_ids, ["still-review"]);
  assertEquals(tables.agh_handoff_records[0].queue_state, "AWAITING_GROK_REVIEW");
  assertEquals((tables.agh_handoff_records[0].packet as Row).email_dispatch, {
    pitch_log_id: "log-b",
    resend_message_id: "re_bounce",
    channel: "email",
    outcome: "bounced",
    bounced_at: sentAt,
  });
  const again = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_bounce", bouncedAt: sentAt });
  assertEquals(again.updated_ids, []);

  const restored = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_was_sent", bouncedAt: sentAt });
  assertEquals(restored.updated_ids, ["false-sent"]);
  assertEquals(tables.agh_handoff_records[1].queue_state, "GROK_REVIEWED");
  assertEquals(((tables.agh_handoff_records[1].packet as Row).email_dispatch as Row).outcome, "bounced");
  assertEquals(((tables.agh_handoff_records[1].packet as Row).email_dispatch as Row).prior_queue_state, "GROK_REVIEWED");

  const fendi = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_fendi_bounce", bouncedAt: sentAt });
  assertEquals(fendi.updated_ids, []);
  assertEquals(tables.agh_handoff_records[2].queue_state, "GROK_REVIEWED");
  assertEquals((tables.agh_handoff_records[2].packet as Row).email_dispatch, undefined);

  const plate = await markLinkedHandoffEmailBounced(sb, { resendMessageId: "re_plate_bounce", bouncedAt: sentAt });
  assertEquals(plate.updated_ids, []);
  assertEquals(tables.agh_handoff_records[3].queue_state, "IMPORTED_TO_AGH");
  assertEquals((tables.agh_handoff_records[3].packet as Row).email_dispatch, undefined);
});

Deno.test("a finished batch rolls to SENT with the dispatching actor", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_batches: [
      { id: "batch-done", queue_state: "APPROVED_FOR_SEND", sent_by: null, sent_by_label: null },
      { id: "batch-open", queue_state: "APPROVED_FOR_SEND", sent_by: null, sent_by_label: null },
      { id: "batch-imported", queue_state: "IMPORTED_TO_AGH", sent_by: null, sent_by_label: null },
    ],
    agh_handoff_records: [
      {
        id: "email-last",
        batch_id: "batch-done",
        outreach_draft_id: "draft-1",
        playlist_target_id: "pl-1",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        approved_by: "record-approver",
        approved_by_label: "Record Approver",
        packet: { grok_review: { verdict: "PASS" } },
      },
      {
        id: "email-earlier",
        batch_id: "batch-done",
        outreach_draft_id: "draft-earlier",
        playlist_target_id: "pl-earlier",
        track_id: "track-1",
        queue_state: "SENT",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "form-open",
        batch_id: "batch-open",
        outreach_draft_id: "draft-1",
        playlist_target_id: "pl-1",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "web_form",
        packet: {},
      },
      {
        id: "email-open",
        batch_id: "batch-open",
        outreach_draft_id: "draft-open",
        playlist_target_id: "pl-open",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "email-imported",
        batch_id: "batch-imported",
        outreach_draft_id: "draft-imported",
        playlist_target_id: "pl-imported",
        track_id: "track-imported",
        queue_state: "IMPORTED_TO_AGH",
        submission_channel: "email",
        packet: {},
      },
    ],
    outreach_drafts: [
      { id: "draft-1", generated_by: "grok_cos" },
      { id: "draft-earlier", generated_by: "grok_cos" },
      { id: "draft-open", generated_by: "grok_cos" },
      { id: "draft-imported", generated_by: "claude_playlist_discovery" },
    ],
  });
  const res = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-1",
    playlistId: "pl-1",
    trackId: "track-1",
    pitchLogId: "log-1",
    resendMessageId: "re_123",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["email-last"]);
  const done = tables.agh_handoff_batches.find((b) => b.id === "batch-done")!;
  assertEquals(done.queue_state, "SENT");
  assertEquals(done.sent_by, "grok_playlist_control");
  assertEquals(done.sent_by_label, "grok_playlist_control");
  assertEquals(done.updated_at, sentAt);
  const open = tables.agh_handoff_batches.find((b) => b.id === "batch-open")!;
  assertEquals(open.queue_state, "APPROVED_FOR_SEND");
  assertEquals(open.sent_by, null);
  const byId = new Map(tables.agh_handoff_records.map((r) => [String(r.id), r]));
  assertEquals(byId.get("email-last")!.queue_state, "SENT");
  assertEquals(byId.get("email-last")!.submitted_at, undefined);
  assertEquals((byId.get("email-last")!.packet as Row).email_dispatch, {
    pitch_log_id: "log-1",
    resend_message_id: "re_123",
    sent_at: sentAt,
    channel: "email",
    outcome: "sent",
    prior_queue_state: "APPROVED_FOR_SEND",
  });
  assertEquals(byId.get("form-open")!.queue_state, "APPROVED_FOR_SEND");
  assertEquals(byId.get("email-open")!.queue_state, "APPROVED_FOR_SEND");

  const imported = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-imported",
    playlistId: "pl-imported",
    trackId: "track-imported",
    pitchLogId: "log-imported",
    resendMessageId: "re_imported",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(imported.updated_ids, ["email-imported"]);
  const importedBatch = tables.agh_handoff_batches.find((b) => b.id === "batch-imported")!;
  assertEquals(importedBatch.queue_state, "SENT");
  assertEquals(importedBatch.sent_by, "grok_playlist_control");
  assertEquals(importedBatch.sent_by_label, "grok_playlist_control");
});

Deno.test("a batch stays put until every record is SENT, and a later call does not rewrite sent_by", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_batches: [
      { id: "batch-partial", queue_state: "APPROVED_FOR_SEND", sent_by: null, sent_by_label: null },
      { id: "batch-kept", queue_state: "SENT", sent_by: "earlier-actor", sent_by_label: "Earlier Actor" },
    ],
    agh_handoff_records: [
      {
        id: "email-partial",
        batch_id: "batch-partial",
        outreach_draft_id: "draft-partial",
        playlist_target_id: "pl-partial",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "still-review",
        batch_id: "batch-partial",
        outreach_draft_id: "draft-review",
        playlist_target_id: "pl-review",
        track_id: "track-1",
        queue_state: "AWAITING_GROK_REVIEW",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "email-kept",
        batch_id: "batch-kept",
        outreach_draft_id: "draft-kept",
        playlist_target_id: "pl-kept",
        track_id: "track-kept",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        approved_by: "record-approver",
        approved_by_label: "Record Approver",
        packet: {},
      },
    ],
    outreach_drafts: [
      { id: "draft-partial", generated_by: "grok_cos" },
      { id: "draft-review", generated_by: "grok_cos" },
      { id: "draft-kept", generated_by: "grok_cos" },
    ],
  });
  const partial = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-partial",
    playlistId: null,
    trackId: null,
    pitchLogId: "log-partial",
    resendMessageId: "re_partial",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(partial.error, undefined);
  assertEquals(partial.updated_ids, ["email-partial"]);
  assertEquals(tables.agh_handoff_batches[0].queue_state, "APPROVED_FOR_SEND");
  assertEquals(tables.agh_handoff_batches[0].sent_by, null);
  assertEquals(tables.agh_handoff_records[1].queue_state, "AWAITING_GROK_REVIEW");

  const kept = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-kept",
    playlistId: null,
    trackId: null,
    pitchLogId: "log-kept",
    resendMessageId: "re_kept",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(kept.updated_ids, ["email-kept"]);
  assertEquals(tables.agh_handoff_batches[1].queue_state, "SENT");
  assertEquals(tables.agh_handoff_batches[1].sent_by, "earlier-actor");
  assertEquals(tables.agh_handoff_batches[1].sent_by_label, "Earlier Actor");

  const again = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-kept",
    playlistId: null,
    trackId: null,
    pitchLogId: "log-kept",
    resendMessageId: "re_kept",
    sentAt: "2026-10-22T12:00:00.000Z",
    sentBy: "someone-else",
    sentByLabel: "Someone Else",
  });
  assertEquals(again.updated_ids, []);
  assertEquals(tables.agh_handoff_batches[1].sent_by, "earlier-actor");
  assertEquals(tables.agh_handoff_batches[1].updated_at, undefined);
});

Deno.test("a fendi draft is not moved and does not roll its batch", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_batches: [
      { id: "batch-fendi", queue_state: "APPROVED_FOR_SEND", sent_by: null, sent_by_label: null },
      { id: "batch-mixed", queue_state: "APPROVED_FOR_SEND", sent_by: null, sent_by_label: null },
    ],
    agh_handoff_records: [
      {
        id: "fendi-row",
        batch_id: "batch-fendi",
        outreach_draft_id: "fendi-draft",
        playlist_target_id: "pl-fendi",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "normal-row",
        batch_id: "batch-mixed",
        outreach_draft_id: "normal-draft",
        playlist_target_id: "pl-normal",
        track_id: "track-1",
        queue_state: "APPROVED_FOR_SEND",
        submission_channel: "email",
        packet: {},
      },
      {
        id: "fendi-sibling",
        batch_id: "batch-mixed",
        outreach_draft_id: "fendi-sibling",
        playlist_target_id: "pl-fendi-sib",
        track_id: "track-1",
        queue_state: "SENT",
        submission_channel: "email",
        packet: {},
      },
    ],
    outreach_drafts: [
      { id: "fendi-draft", generated_by: "fendi" },
      { id: "normal-draft", generated_by: "grok_cos" },
      { id: "fendi-sibling", generated_by: "fendi" },
    ],
  });
  const fendi = await markLinkedHandoffEmailSent(sb, {
    draftId: "fendi-draft",
    playlistId: "pl-fendi",
    trackId: "track-1",
    pitchLogId: "log-f",
    resendMessageId: "re_fendi",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(fendi.updated_ids, []);
  assertEquals(tables.agh_handoff_records[0].queue_state, "APPROVED_FOR_SEND");
  assertEquals(tables.agh_handoff_batches[0].queue_state, "APPROVED_FOR_SEND");
  assertEquals(tables.agh_handoff_batches[0].sent_by, null);

  const mixed = await markLinkedHandoffEmailSent(sb, {
    draftId: "normal-draft",
    playlistId: null,
    trackId: null,
    pitchLogId: "log-n",
    resendMessageId: "re_normal",
    sentAt,
    sentBy: "grok_playlist_control",
    sentByLabel: "grok_playlist_control",
  });
  assertEquals(mixed.updated_ids, ["normal-row"]);
  assertEquals(tables.agh_handoff_records[1].queue_state, "SENT");
  assertEquals(tables.agh_handoff_records[2].queue_state, "SENT");
  assertEquals(tables.agh_handoff_batches[1].queue_state, "APPROVED_FOR_SEND");
  assertEquals(tables.agh_handoff_batches[1].sent_by, null);
});

Deno.test("a missing dispatching actor falls back to the record approver", async () => {
  const { sb, tables } = stubSb({
    agh_handoff_batches: [
      { id: "batch-approver", queue_state: "IMPORTED_TO_AGH", sent_by: null, sent_by_label: null },
    ],
    agh_handoff_records: [
      {
        id: "email-approver",
        batch_id: "batch-approver",
        outreach_draft_id: "draft-approver",
        playlist_target_id: "pl-approver",
        track_id: "track-1",
        queue_state: "IMPORTED_TO_AGH",
        submission_channel: "email",
        approved_by: "grok_playlist_control",
        approved_by_label: "grok_playlist_control",
        packet: {},
      },
    ],
    outreach_drafts: [{ id: "draft-approver", generated_by: "claude_playlist_discovery" }],
  });
  const res = await markLinkedHandoffEmailSent(sb, {
    draftId: "draft-approver",
    playlistId: null,
    trackId: null,
    pitchLogId: "log-a",
    resendMessageId: "re_approver",
    sentAt,
  });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["email-approver"]);
  assertEquals(tables.agh_handoff_batches[0].queue_state, "SENT");
  assertEquals(tables.agh_handoff_batches[0].sent_by, "grok_playlist_control");
  assertEquals(tables.agh_handoff_batches[0].sent_by_label, "grok_playlist_control");
});

Deno.test("batch sent backfill only rolls batches and does not resend", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../migrations/20261022140000_handoff_batch_sent_rollup.sql", import.meta.url),
  );
  const exec = Deno.readTextFileSync(new URL("../execute-pitch/index.ts", import.meta.url));
  const send = Deno.readTextFileSync(new URL("../send-pitch-email/index.ts", import.meta.url));
  assert(sql.includes("queue_state = 'SENT'"));
  assert(sql.includes("sent_by"));
  assert(sql.includes("sent_by_label"));
  assert(sql.includes("trim(d.generated_by) = 'fendi'"));
  assert(sql.includes("packet.email_dispatch"));
  assert(!/insert\s+into\s+(public\.)?pitch_log/i.test(sql));
  assert(!/update\s+(public\.)?outreach_drafts/i.test(sql));
  assert(!/update\s+(public\.)?agh_handoff_records/i.test(sql));
  assert(!/resend/i.test(sql));
  assert(!/net\.http/i.test(sql));
  for (const id of [
    "0332f2aa-da2b-4530-be35-85d086341649",
    "94dd3881-fab2-4096-a2a5-3f565593cc0e",
    "89302ebe-9f40-415a-8aa3-bae47ca82282",
    "a5b61bee-88e9-426a-9e28-baa2288f67c5",
    "4f2bbad3-496a-4f3b-9b3d-663a732620cb",
    "d7af2f98-5955-4611-b7ad-4706afa99d29",
    "addd70ff-17c1-4363-b884-a3dd5a9a8bd6",
    "219b7c3f-7c16-4106-9210-0bbeedc13fe5",
    "8129e879-c814-4a51-aa73-9c57f5a44408",
    "f4229e77-9fe6-4271-bf3d-f5dc457c33f9",
  ]) {
    assert(sql.includes(id), id);
  }
  assert(exec.includes("sentBy: approvedBy"));
  assert(exec.includes("sentByLabel: approvedBy"));
  assert(exec.includes('draft.generated_by === "fendi"'));
  assert(exec.includes('p_channel: "email"'));
  assert(send.includes("sentBy: dispatchingActor || null"));
  assert(send.includes("String(draft.approved_by"));
});

Deno.test("resend webhook records the bounce on the linked handoff", () => {
  const src = Deno.readTextFileSync(new URL("../resend-webhook/index.ts", import.meta.url));
  const bounce = Deno.readTextFileSync(new URL("./resend-webhook-event.ts", import.meta.url));
  assert(src.includes("markLinkedHandoffEmailBounced"));
  assert(src.includes("pitchLogBouncePatch"));
  assert(bounce.includes('status: "bounced"'));
  assert(bounce.includes('placement_status: "bounced"'));
  assert(bounce.includes("cooldown_until: null"));
});
