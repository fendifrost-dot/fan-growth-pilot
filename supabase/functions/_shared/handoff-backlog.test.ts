/**
 * Handoff backlog: decided-batch rollup, review-queue paging, null-date
 * promotion selection, Muse receipt scope, and 7-day pending age.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  advanceClaudeReadyBatches,
  decidedBatchRollupTarget,
  markManualFormSubmitted,
  markManualIgDmSubmitted,
  runHandoffAction,
} from "./handoff-queues.ts";
import { can, resolveOpsActor } from "./ops-actors.ts";
import { authorizeAction, type Actor } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

function req(headers: Record<string, string>): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    if (v === "") Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  const done = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(done);
    }
    done();
  } catch (err) {
    done();
    throw err;
  }
}

Deno.test("decided batch rollup treats approved, sent, and imported as decided", () => {
  const base = {
    total: 2,
    awaiting: 0,
    reviewed: 0,
    rejected: 1,
    approved: 0,
    awaitingImport: 0,
    sent: 0,
    imported: 0,
  };
  assertEquals(decidedBatchRollupTarget({ ...base, approved: 1 }), "APPROVED_FOR_SEND");
  assertEquals(decidedBatchRollupTarget({ ...base, awaitingImport: 1 }), "APPROVED_FOR_SEND");
  assertEquals(decidedBatchRollupTarget({ ...base, sent: 1 }), "SENT");
  assertEquals(decidedBatchRollupTarget({ ...base, imported: 1, sent: 0 }), "IMPORTED_TO_AGH");
  assertEquals(decidedBatchRollupTarget({ ...base, sent: 1, imported: 1, rejected: 0, total: 2 }), "APPROVED_FOR_SEND");
  assertEquals(decidedBatchRollupTarget({ ...base, rejected: 2, total: 2 }), "REJECTED_BY_GROK");
  assertEquals(decidedBatchRollupTarget({ ...base, reviewed: 1 }), "GROK_REVIEWED");
  assertEquals(decidedBatchRollupTarget({ ...base, awaiting: 1, approved: 1 }), null);
  assertEquals(decidedBatchRollupTarget({ ...base, total: 0, rejected: 0 }), null);
  assertEquals(
    decidedBatchRollupTarget({ ...base, total: 2, rejected: 0, approved: 0 }),
    null,
  );
});

type QueryChain = {
  select: () => QueryChain;
  eq: (k: string, v: unknown) => QueryChain;
  in: (k: string, v: unknown[]) => QueryChain;
  order: (col: string, o?: { ascending?: boolean }) => QueryChain;
  limit: (n: number) => QueryChain;
  range: (a: number, b: number) => QueryChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
};

function queueStub(tables: Record<string, Row[]>) {
  return {
    from(table: string): QueryChain {
      const filters: ((r: Row) => boolean)[] = [];
      let asc = true;
      let orderCol: string | null = null;
      let from = 0;
      let to: number | null = null;
      const all = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          rows = [...rows].sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])) * (asc ? 1 : -1));
        }
        return rows;
      };
      const chain: QueryChain = {
        select: () => chain,
        eq: (k, v) => (filters.push((r) => String(r[k]) === String(v)), chain),
        in: (k, v) => (filters.push((r) => v.map(String).includes(String(r[k]))), chain),
        order: (col, o) => ((orderCol = col), (asc = o?.ascending !== false), chain),
        limit: (n) => ((to = from + n - 1), chain),
        range: (a, b) => ((from = a), (to = b), chain),
        maybeSingle: () => Promise.resolve({ data: all()[0] ?? null, error: null }),
        then: (resolve) => {
          const rows = all();
          const page = rows.slice(from, to == null ? undefined : to + 1);
          return Promise.resolve(resolve({ data: page, error: null, count: rows.length }));
        },
      };
      return chain;
    },
  };
}

Deno.test("review_queue pages pending records oldest-first across dates and omits packets", async () => {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  const grokReq = req({ "x-grok-playlist-control-secret": "grok-secret" });
  const sb = queueStub({
    agh_handoff_batches: [
      { id: "old-batch", batch_kind: "playlist", business_date_ct: "2026-09-09", discovered_by: "claude_playlist_discovery" },
      { id: "mid-batch", batch_kind: "playlist", business_date_ct: null, discovered_by: "claude_playlist_discovery" },
      { id: "new-batch", batch_kind: "playlist", business_date_ct: "2026-10-13", discovered_by: "claude_playlist_discovery" },
      { id: "sync-batch", batch_kind: "sync", business_date_ct: "2026-09-01", discovered_by: "claude_playlist_discovery" },
    ],
    agh_handoff_records: [
      {
        id: "rec-new",
        batch_id: "new-batch",
        queue_state: "AWAITING_GROK_REVIEW",
        created_at: "2026-10-13T00:00:00.000Z",
        track_id: "track-1",
        playlist_target_id: "pl-new",
        submission_channel: "instagram_dm",
        song_dna_version_id: "dna-1",
        packet: { leak: "packet-should-not-leak" },
      },
      {
        id: "rec-old",
        batch_id: "old-batch",
        queue_state: "AWAITING_GROK_REVIEW",
        created_at: "2026-09-09T00:00:00.000Z",
        track_id: "track-1",
        playlist_target_id: "pl-old",
        submission_channel: "email",
        song_dna_version_id: "dna-1",
        packet: { leak: "packet-should-not-leak" },
      },
      {
        id: "rec-mid",
        batch_id: "mid-batch",
        queue_state: "AWAITING_GROK_REVIEW",
        created_at: "2026-09-28T00:00:00.000Z",
        track_id: "track-1",
        playlist_target_id: "pl-mid",
        submission_channel: "web_form",
        song_dna_version_id: "dna-1",
      },
      {
        id: "rec-sync",
        batch_id: "sync-batch",
        queue_state: "AWAITING_GROK_REVIEW",
        created_at: "2026-08-01T00:00:00.000Z",
        playlist_target_id: "pl-sync",
      },
      {
        id: "rec-sent",
        batch_id: "old-batch",
        queue_state: "SENT",
        created_at: "2026-09-01T00:00:00.000Z",
        playlist_target_id: "pl-sent",
      },
    ],
  });
  const first = await runHandoffAction("review_queue", { limit: 2 }, sb, null, grokReq);
  assertEquals(first.status, 200, JSON.stringify(first.data));
  assertEquals(first.data.order, "oldest_first");
  assertEquals(first.data.queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(first.data.total_count, 3);
  assertEquals(first.data.has_more, true);
  const rows = first.data.rows as Row[];
  assertEquals(rows.map((r) => r.id), ["rec-old", "rec-mid"]);
  assertEquals(rows[0].business_date_ct, "2026-09-09");
  assertEquals(rows[1].business_date_ct, null);
  assertEquals(Object.keys(rows[0]).includes("packet"), false);
  assert(!JSON.stringify(rows).includes("packet-should-not-leak"));
  const last = await runHandoffAction("review_queue", { limit: 2, offset: 2 }, sb, null, grokReq);
  assertEquals((last.data.rows as Row[]).map((r) => r.id), ["rec-new"]);
  assertEquals(last.data.has_more, false);
});

Deno.test("advance includes null business_date when a date filter is set", async () => {
  const tables: Record<string, Row[]> = {
    agh_handoff_batches: [
      { id: "dated", queue_state: "CLAUDE_BATCH_READY", batch_kind: "playlist", business_date_ct: "2026-09-10", discovered_by: "claude_playlist_discovery" },
      { id: "undated", queue_state: "CLAUDE_BATCH_READY", batch_kind: "playlist", business_date_ct: null, discovered_by: "claude_playlist_discovery" },
      { id: "other-day", queue_state: "CLAUDE_BATCH_READY", batch_kind: "playlist", business_date_ct: "2026-10-01", discovered_by: "claude_playlist_discovery" },
    ],
    agh_handoff_records: [
      { id: "r-dated", batch_id: "dated", queue_state: "CLAUDE_BATCH_READY", packet: {} },
      { id: "r-undated", batch_id: "undated", queue_state: "CLAUDE_BATCH_READY", packet: {} },
      { id: "r-other", batch_id: "other-day", queue_state: "CLAUDE_BATCH_READY", packet: {} },
    ],
  };
  const writes: string[] = [];
  const sb = {
    rpc: (name: string) => {
      writes.push(name);
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k]) === String(v)), chain),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.map(String).includes(String(r[k]))), chain),
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({
          data: (tables[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({
          data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))),
          error: null,
        })),
      };
      return chain;
    },
  };
  const res = await advanceClaudeReadyBatches(
    sb,
    { business_date_ct: "2026-09-10", dry_run: true },
    { kind: "claude_playlist_discovery", userId: null, label: "claude_playlist_discovery" },
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.dry_run, true);
  assertEquals(
    (res.data.would_move as Row[]).map((r) => r.batch_id).sort(),
    ["dated", "undated"],
  );
  assertEquals(writes, []);
  assertEquals(tables.agh_handoff_batches.map((b) => b.queue_state), [
    "CLAUDE_BATCH_READY",
    "CLAUDE_BATCH_READY",
    "CLAUDE_BATCH_READY",
  ]);
});

Deno.test("pipeline report oldest_pending_age follows the oldest pending record", async () => {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * 864e5).toISOString();
  const sb = queueStub({
    agh_handoff_batches: [
      { id: "newer-batch", batch_kind: "playlist", queue_state: "AWAITING_GROK_REVIEW", created_at: daysAgo(1), discovered_by: "claude_playlist_discovery" },
    ],
    agh_handoff_records: [
      { id: "young", batch_id: "newer-batch", queue_state: "AWAITING_GROK_REVIEW", created_at: daysAgo(2), packet: {} },
      { id: "old-rec", batch_id: "newer-batch", queue_state: "AWAITING_GROK_REVIEW", created_at: daysAgo(8), packet: {} },
      { id: "reviewed", batch_id: "newer-batch", queue_state: "GROK_REVIEWED", created_at: daysAgo(30), packet: {} },
    ],
  });
  const res = await runHandoffAction(
    "playlist_pipeline_report",
    {},
    sb,
    null,
    req({ "x-grok-playlist-control-secret": "grok-secret" }),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  const backlog = (res.data.review_backlog ?? {}) as Row;
  assertEquals(backlog.oldest_pending_record_id, "old-rec");
  assertEquals(backlog.oldest_pending_age, 8);
});

Deno.test("muse_ig_receipt may only record an approved Instagram DM receipt", async () => {
  await withEnv({
    MUSE_IG_RECEIPT_SECRET: "muse-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
    FANFUEL_HUB_KEY: "hub-secret",
    CLAUDE_AGENT_SECRET: "claude-secret",
  }, async () => {
    const muse = req({ "x-muse-ig-receipt-secret": "muse-secret" });
    const sb = { auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) } };
    const allowed = await authorizeAction("mark_manual_ig_dm_submitted", muse, sb as never);
    assert(allowed.ok, JSON.stringify(allowed));
    assert(allowed.ok && allowed.opsActor.kind === "muse_ig_receipt");
    assertEquals(can(allowed.ok ? allowed.opsActor : { kind: "muse_ig_receipt", userId: null, label: "muse_ig_receipt" }, "send_playlist_pitches"), false);
    assertEquals(can(allowed.ok ? allowed.opsActor : { kind: "muse_ig_receipt", userId: null, label: "x" }, "approve_playlist_drafts"), false);
    assertEquals(can(allowed.ok ? allowed.opsActor : { kind: "muse_ig_receipt", userId: null, label: "x" }, "review_handoff_batch"), false);

    for (const action of [
      "list_handoff_batches",
      "review_queue",
      "approve_handoff_records",
      "review_handoff_records",
      "mark_manual_form_submitted",
      "promote_stranded_claude_batches",
      "playlist_pipeline_report",
      "list_campaigns",
    ]) {
      const denied = await authorizeAction(action, muse, sb as never);
      assertEquals(denied.ok, false, action);
    }

    const viaKey = await authorizeAction(
      "mark_manual_ig_dm_submitted",
      req({ "x-api-key": "muse-secret" }),
      sb as never,
    );
    assert(viaKey.ok && viaKey.opsActor.kind === "muse_ig_receipt");

    const hubActor = resolveOpsActor(null, req({ "x-api-key": "hub-secret" }));
    assertEquals(hubActor.kind, "service");

    const grokWins = resolveOpsActor(null, req({ "x-api-key": "grok-secret" }));
    assertEquals(grokWins.kind, "grok_playlist_control");

    const ops = resolveOpsActor(null, muse);
    const web = await markManualFormSubmitted({} as never, {}, ops);
    assertEquals(web.status, 403);
    assertEquals(web.data.code, "muse_ig_receipt_scope");

    const missing = await markManualIgDmSubmitted({} as never, {}, ops);
    assertEquals(missing.status, 400);
    assertEquals(missing.data.code, "missing_handoff_record_id");

    const notApproved = await markManualIgDmSubmitted(
      queueStub({
        agh_handoff_records: [{ id: "rec-1", queue_state: "AWAITING_GROK_REVIEW", packet: {} }],
      }),
      { handoff_record_id: "rec-1" },
      ops,
    );
    assertEquals(notApproved.status, 422);
    assertEquals(notApproved.data.code, "not_approved_for_send");
  });
});

Deno.test("muse secret that copies the hub key does not become muse", () => {
  withEnv({
    MUSE_IG_RECEIPT_SECRET: "same-secret",
    FANFUEL_HUB_KEY: "same-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, () => {
    const actor = resolveOpsActor(null, req({ "x-api-key": "same-secret" }));
    assertEquals(actor.kind, "service");
  });
});

Deno.test("scheduled promotion SQL keeps null dates and does not approve", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261013150000_handoff_backlog_rollup_promotion.sql", import.meta.url));
  assert(sql.includes("b.business_date_ct is null"));
  assert(sql.includes("interval '7 days'"));
  assert(sql.includes("pending_review_aged"));
  assert(sql.includes("agh_handoff_batches_queue_state_check"));
  assert(sql.includes("'SENT'"));
  assert(sql.includes("select public.agh_handoff_backlog_maintenance(false)"));
  assert(sql.includes("p_dry_run boolean default true"));
  const promote = sql.slice(sql.indexOf("function public.agh_promote_claude_ready_batches"));
  const promoteBody = promote.slice(0, promote.indexOf("function public.agh_age_pending_handoff_records"));
  assert(promoteBody.includes("'AWAITING_GROK_REVIEW'"));
  assert(!promoteBody.includes("'APPROVED_FOR_SEND'"));
  assert(!promoteBody.includes("'GROK_REVIEWED'"));
  assert(sql.includes("not in ('fendi','grok_playlist_control')"));
});
