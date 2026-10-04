import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { markLinkedHandoffEmailSent } from "./handoff-sent.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>) {
  const updates: { id: string; row: Row }[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k] ?? "") === String(v ?? "")), chain),
        update: (row: Row) => {
          const write: any = {
            eq: (k: string, v: unknown) => (filters.push((r) => String(r[k] ?? "") === String(v ?? "")), write),
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
    sentAt: "2026-10-03T18:00:00.000Z",
  });
  assertEquals(res.error, undefined);
  assertEquals(res.updated_ids, ["email-1"]);
  assertEquals(tables.agh_handoff_records[0].queue_state, "SENT");
  assertEquals(
    (tables.agh_handoff_records[0].packet as Row).email_dispatch,
    {
      pitch_log_id: "log-1",
      resend_message_id: "re_123",
      sent_at: "2026-10-03T18:00:00.000Z",
      channel: "email",
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
    sentAt: "2026-10-03T18:00:00.000Z",
  });
  assertEquals(res.updated_ids, []);
  assertEquals(tables.agh_handoff_records[0].queue_state, "APPROVED_FOR_SEND");
});
