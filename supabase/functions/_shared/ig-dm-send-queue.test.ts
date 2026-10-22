import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  IG_RECEIPT_ACTION,
  IG_SEND_OWNER,
  igHandleOf,
  igSendQueueReadable,
  listIgDmSendQueue,
  pickSendDraft,
  sendQueueRow,
} from "./ig-dm-send-queue.ts";
import { resolveOpsActor } from "./ops-actors.ts";
import { authorizeAction, MUSE_IG_ACTIONS } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

const MUSE = "muse-receipt-secret";
const GROK = "grok-control-secret";
const DISCOVERY = "pd-secret-narrow-only";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}

const ENV = {
  MUSE_IG_RECEIPT_SECRET: MUSE,
  GROK_PLAYLIST_CONTROL_SECRET: GROK,
  CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
  FANFUEL_HUB_KEY: "hub-service-key",
  CLAUDE_AGENT_SECRET: "claude-agent-secret",
  CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
  OUTREACH_SCHEDULER_SECRET: "scheduler-secret",
};

function museActor() {
  return resolveOpsActor(null, req({ "x-muse-ig-receipt-secret": MUSE }));
}
function grokActor() {
  return resolveOpsActor(null, req({ "x-grok-playlist-control-secret": GROK }));
}
function discoveryActor() {
  return resolveOpsActor(null, req({ "x-claude-playlist-discovery-secret": DISCOVERY }));
}

/** Minimal in-memory client: eq / in / is filters, select with count. */
function stubSb(tables: Record<string, Row[]>) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let sortBy: { col: string; asc: boolean } | null = null;
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
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
        is: (k: string, v: unknown) => {
          if (v === null) filters.push((r) => r[k] == null || String(r[k]).trim() === "");
          return chain;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          sortBy = { col, asc: opts?.ascending !== false };
          return chain;
        },
        limit: () => chain,
        then: (resolve: (v: unknown) => void) => {
          const data = rows();
          if (sortBy) {
            const { col, asc } = sortBy;
            data.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1));
          }
          resolve({ data, error: null, count: data.length });
        },
      };
      return chain;
    },
  };
  return sb;
}

function fixture(): Record<string, Row[]> {
  return {
    tracks: [{ id: "track-med", name: "Meditate" }],
    playlist_targets: [
      { playlist_id: "pl-a", playlist_name: "Lyrical Rap", ig_curator_account: "akhilsagar", is_active: true },
      { playlist_id: "pl-b", playlist_name: "Rap & Trap", ig_curator_account: "linmusiclist", is_active: true },
      { playlist_id: "pl-c", playlist_name: "Old List", ig_curator_account: "oldhandle", is_active: true },
    ],
    outreach_drafts: [
      {
        id: "draft-a", track_id: "track-med", playlist_id: "pl-a", channel: "instagram_dm", status: "approved",
        body: "Hi Akhil, Meditate for Lyrical Rap. Stream: https://open.spotify.com/track/x",
        recipient: "@akhilsagar", generated_by: "claude_playlist_discovery", approved_by: "grok_playlist_control",
        approved_at: "2026-10-22T15:00:00Z", generated_at: "2026-10-22T14:00:00Z", metadata: { handoff_record_id: "rec-a" },
      },
      {
        id: "draft-b", track_id: "track-med", playlist_id: "pl-b", channel: "instagram_dm", status: "pending",
        body: "not approved yet", recipient: "@linmusiclist", generated_by: "claude_playlist_discovery",
        generated_at: "2026-10-22T14:00:00Z", metadata: {},
      },
      // Older record with no draft link at all; one approved pair draft exists.
      {
        id: "draft-c", track_id: "track-med", playlist_id: "pl-c", channel: "instagram_dm", status: "approved",
        body: "Older approved DM", recipient: "oldhandle", generated_by: "grok_cos", approved_by: "grok_playlist_control",
        generated_at: "2026-10-09T15:00:00Z", metadata: {},
      },
    ],
    agh_handoff_records: [
      { id: "rec-a", batch_id: "b1", track_id: "track-med", playlist_target_id: "pl-a", queue_state: "APPROVED_FOR_SEND", submission_channel: "instagram_dm", approved_by: "grok_playlist_control", outreach_draft_id: "draft-a", packet: { ig_curator_account: "akhilsagar" }, submitted_at: null, updated_at: "2026-10-22T15:00:00Z" },
      { id: "rec-b", batch_id: "b1", track_id: "track-med", playlist_target_id: "pl-b", queue_state: "APPROVED_FOR_SEND", submission_channel: "instagram_dm", approved_by: "grok_playlist_control", outreach_draft_id: "draft-b", packet: { ig_curator_account: "linmusiclist" }, submitted_at: null, updated_at: "2026-10-22T15:01:00Z" },
      { id: "rec-c", batch_id: "b0", track_id: "track-med", playlist_target_id: "pl-c", queue_state: "APPROVED_FOR_SEND", submission_channel: "instagram_dm", approved_by: "grok_playlist_control", outreach_draft_id: null, packet: { ig_curator_account: "oldhandle" }, submitted_at: null, updated_at: "2026-10-09T15:30:00Z" },
      // Already sent: not in the queue.
      { id: "rec-sent", batch_id: "b0", track_id: "track-med", playlist_target_id: "pl-a", queue_state: "SENT", submission_channel: "instagram_dm", submitted_at: "2026-10-14T15:00:00Z", packet: {} },
      // Still in review: not in the queue.
      { id: "rec-review", batch_id: "b2", track_id: "track-med", playlist_target_id: "pl-b", queue_state: "AWAITING_GROK_REVIEW", submission_channel: "instagram_dm", submitted_at: null, packet: {} },
      // Email: not in the queue.
      { id: "rec-email", batch_id: "b2", track_id: "track-med", playlist_target_id: "pl-a", queue_state: "APPROVED_FOR_SEND", submission_channel: "email", submitted_at: null, packet: {} },
    ],
  };
}

Deno.test("Muse, Grok and Fendi can read the send queue; the discovery credential cannot", async () => {
  await withEnv(ENV, () => {
    assert(igSendQueueReadable(museActor()));
    assert(igSendQueueReadable(grokActor()));
    assert(igSendQueueReadable({ kind: "fendi", userId: "u", label: "fendi" }));
    assert(!igSendQueueReadable(discoveryActor()));
  });
});

Deno.test("send queue lists approved unsent Instagram handoffs with the approved DM text and the handle", async () => {
  await withEnv(ENV, async () => {
    const res = await listIgDmSendQueue(stubSb(fixture()), {}, museActor());
    assertEquals(res.status, 200, JSON.stringify(res.data));
    assertEquals(res.data.send_owner, IG_SEND_OWNER);
    assertEquals(res.data.receipt_action, IG_RECEIPT_ACTION);
    const rows = res.data.rows as Row[];
    assertEquals(rows.map((r) => r.handoff_record_id), ["rec-c", "rec-a", "rec-b"]);

    const a = rows.find((r) => r.handoff_record_id === "rec-a")!;
    assertEquals(a.sendable, true);
    assertEquals(a.ig_handle, "@akhilsagar");
    assertEquals(a.ig_url, "https://instagram.com/akhilsagar");
    assertEquals(a.dm_body, "Hi Akhil, Meditate for Lyrical Rap. Stream: https://open.spotify.com/track/x");
    assertEquals(a.outreach_draft_id, "draft-a");
    assertEquals(a.generated_by, "claude_playlist_discovery");
    assertEquals(a.track_name, "Meditate");
    assertEquals(a.playlist_name, "Lyrical Rap");

    const b = rows.find((r) => r.handoff_record_id === "rec-b")!;
    assertEquals(b.sendable, false);
    assertEquals(b.blockers, ["draft_pending"]);
    assertEquals(b.dm_body, null);

    const c = rows.find((r) => r.handoff_record_id === "rec-c")!;
    assertEquals(c.sendable, true);
    assertEquals(c.outreach_draft_id, "draft-c");
    assertEquals(c.ig_handle, "@oldhandle");
    assertEquals(res.data.sendable_count, 2);
  });
});

Deno.test("send queue refuses the discovery credential", async () => {
  await withEnv(ENV, async () => {
    const res = await listIgDmSendQueue(stubSb(fixture()), {}, discoveryActor());
    assertEquals(res.status, 403);
  });
});

Deno.test("send queue row: a Fendi-authored draft is attribution-held, a missing handle blocks", () => {
  const held = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", outreach_draft_id: "d", packet: {} },
    { id: "d", status: "approved", body: "x", recipient: "@held_handle", generated_by: "fendi" },
    { playlist_name: "P", is_active: true },
    "T",
  );
  assertEquals(held.sendable, false);
  assertEquals(held.blockers, ["attribution_held"]);

  const noHandle = sendQueueRow(
    { id: "r", playlist_target_id: "p", track_id: "t", outreach_draft_id: "d", packet: {} },
    { id: "d", status: "approved", body: "x", recipient: "https://instagram.com/x", generated_by: "claude_playlist_discovery" },
    { playlist_name: "P", is_active: true },
    "T",
  );
  assertEquals(noHandle.blockers, ["ig_handle_missing"]);
  assertEquals(noHandle.dm_body, null);
});

Deno.test("pickSendDraft prefers the linked draft, then the one pointing at the record, then the oldest approved", () => {
  const drafts: Row[] = [
    { id: "late", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-20T00:00:00Z", metadata: {} },
    { id: "early", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-10T00:00:00Z", metadata: {} },
    { id: "pointed", track_id: "t", playlist_id: "p", channel: "instagram_dm", status: "approved", generated_at: "2026-10-21T00:00:00Z", metadata: { handoff_record_id: "rec" } },
  ];
  assertEquals(pickSendDraft({ id: "rec", track_id: "t", playlist_target_id: "p", outreach_draft_id: "late" }, drafts)?.id, "late");
  assertEquals(pickSendDraft({ id: "rec", track_id: "t", playlist_target_id: "p", outreach_draft_id: null }, drafts)?.id, "pointed");
  assertEquals(pickSendDraft({ id: "other", track_id: "t", playlist_target_id: "p", outreach_draft_id: null }, drafts)?.id, "early");
  assertEquals(pickSendDraft({ id: "x", track_id: "t", playlist_target_id: "nope" }, drafts), null);
});

Deno.test("igHandleOf normalizes to @handle and rejects URLs", () => {
  assertEquals(igHandleOf("@Some.One"), "@Some.One");
  assertEquals(igHandleOf("", null, "plain_handle"), "@plain_handle");
  assertEquals(igHandleOf("https://instagram.com/x", "x/y"), null);
});

Deno.test("authorization: the Muse credential may read the send queue and record a receipt, nothing else", async () => {
  await withEnv(ENV, async () => {
    assertEquals([...MUSE_IG_ACTIONS].sort(), ["list_ig_dm_send_queue", "mark_manual_ig_dm_submitted"]);
    // deno-lint-ignore no-explicit-any
    const sb: any = { auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
    const muse = req({ "x-muse-ig-receipt-secret": MUSE });
    const read = await authorizeAction("list_ig_dm_send_queue", muse, sb);
    assertEquals(read.ok, true, JSON.stringify(read));
    const receipt = await authorizeAction("mark_manual_ig_dm_submitted", muse, sb);
    assertEquals(receipt.ok, true, JSON.stringify(receipt));
    for (const denied of ["approve_handoff_records", "review_handoff_records", "list_web_form_handoffs", "list_handoff_batches"]) {
      const res = await authorizeAction(denied, muse, sb);
      assertEquals(res.ok, false, denied);
      assertEquals(res.status, 403, denied);
    }
  });
});
