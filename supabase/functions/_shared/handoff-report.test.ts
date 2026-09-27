/**
 * Grok handoff visibility (2026-09-27): backlog paging oldest-first with totals, and a
 * pipeline report that keeps reviewed / approved / submitted / held / rejected separate.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runHandoffAction } from "./handoff-queues.ts";
import { resolveOpsActor } from "./ops-actors.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
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
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push((r) => String(r[k]) === String(v)), chain),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.map(String).includes(String(r[k]))), chain),
        order: (col: string, o?: { ascending?: boolean }) => ((orderCol = col), (asc = o?.ascending !== false), chain),
        limit: (n: number) => ((to = from + n - 1), chain),
        range: (a: number, b: number) => ((from = a), (to = b), chain),
        then: (resolve: (v: unknown) => unknown) => {
          const rows = all();
          const page = rows.slice(from, to == null ? undefined : to + 1);
          return Promise.resolve(resolve({ data: page, error: null, count: rows.length }));
        },
      };
      return chain;
    },
  };
  return sb;
}

function grok() {
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "grok-secret");
  return resolveOpsActor(null, new Request("https://x.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }));
}

function pendingBatches(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `b-${String(i).padStart(3, "0")}`,
    batch_kind: "playlist",
    queue_state: "AWAITING_GROK_REVIEW",
    discovered_by: "claude_playlist_discovery",
    created_at: new Date(Date.UTC(2026, 8, 9) + i * 3600_000).toISOString(),
    record_count: 1,
  }));
}

Deno.test("grok list: oldest-first paging exposes recovered historical batches and the total", async () => {
  grok();
  const sb = stubSb({ agh_handoff_batches: pendingBatches(95) });
  const first = await runHandoffAction(
    "list_handoff_batches",
    { queue_state: "AWAITING_GROK_REVIEW", order: "oldest_first", limit: 40 },
    sb,
    null,
    new Request("https://x.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }),
  );
  assertEquals(first.status, 200, JSON.stringify(first.data));
  assertEquals(first.data.total_count, 95);
  assertEquals((first.data.rows as Row[])[0].id, "b-000"); // oldest recovered batch visible first
  assertEquals(first.data.has_more, true);
  const last = await runHandoffAction(
    "list_handoff_batches",
    { queue_state: "AWAITING_GROK_REVIEW", order: "oldest_first", limit: 40, offset: 80 },
    sb,
    null,
    new Request("https://x.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }),
  );
  assertEquals((last.data.rows as Row[]).length, 15);
  assertEquals(last.data.has_more, false);
});

Deno.test("grok report: backlog, reviewed vs approved vs submitted, holds, rejections, stranded", async () => {
  grok();
  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
  const sb = stubSb({
    agh_handoff_batches: [
      { id: "old-pending", batch_kind: "playlist", queue_state: "AWAITING_GROK_REVIEW", created_at: hoursAgo(50), discovered_by: "claude_playlist_discovery" },
      { id: "new-pending", batch_kind: "playlist", queue_state: "AWAITING_GROK_REVIEW", created_at: hoursAgo(3), discovered_by: "claude_playlist_discovery" },
      { id: "stranded", batch_kind: "playlist", queue_state: "CLAUDE_BATCH_READY", created_at: hoursAgo(26), discovered_by: "claude_playlist_discovery" },
      { id: "repair", batch_kind: "playlist", queue_state: "CLAUDE_BATCH_READY", created_at: hoursAgo(1), discovered_by: "claude_playlist_discovery", payload: { route_hold_repair: true }, record_count: 1 },
      { id: "reviewed", batch_kind: "playlist", queue_state: "GROK_REVIEWED", created_at: hoursAgo(30), discovered_by: "claude_playlist_discovery" },
      { id: "approved", batch_kind: "playlist", queue_state: "APPROVED_FOR_SEND", created_at: hoursAgo(40), discovered_by: "claude_playlist_discovery" },
      { id: "rejected", batch_kind: "playlist", queue_state: "REJECTED_BY_GROK", created_at: hoursAgo(45), discovered_by: "claude_playlist_discovery" },
    ],
    agh_handoff_records: [
      { id: "r1", batch_id: "old-pending", queue_state: "AWAITING_GROK_REVIEW", packet: {} },
      { id: "r2", batch_id: "new-pending", queue_state: "AWAITING_GROK_REVIEW", packet: {} },
      { id: "r3", batch_id: "repair", queue_state: "CLAUDE_BATCH_READY", packet: { route_hold: { code: "spotify_url_as_form" } } },
      { id: "r4", batch_id: "reviewed", queue_state: "GROK_REVIEWED", packet: {} },
      { id: "r5", batch_id: "approved", queue_state: "APPROVED_FOR_SEND", packet: {} },
      { id: "r6", batch_id: "approved", queue_state: "APPROVED_FOR_SEND", submitted_at: hoursAgo(2), packet: {} },
      { id: "r7", batch_id: "rejected", queue_state: "REJECTED_BY_GROK", rejection_reason: "off-genre", packet: {} },
    ],
  });
  const res = await runHandoffAction(
    "playlist_pipeline_report",
    {},
    sb,
    null,
    new Request("https://x.test/", { method: "POST", headers: { "x-grok-playlist-control-secret": "grok-secret" } }),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  const d = res.data as Record<string, any>; // deno-lint-ignore no-explicit-any
  assertEquals(d.review_backlog.batches, 2);
  assertEquals(d.review_backlog.records, 2);
  assertEquals(d.review_backlog.oldest_pending_batch_id, "old-pending");
  assertEquals(d.review_backlog.oldest_pending_age_hours, 50);
  assertEquals(d.reviewed_not_approved_records, 1);
  assertEquals(d.approved_not_submitted_records, 1);
  assertEquals(d.manual_submissions_recorded, 1);
  assertEquals(d.rejected_records, 1);
  assertEquals(d.rejection_reasons, { "off-genre": 1 });
  assertEquals(d.route_holds.by_code, { spotify_url_as_form: 1 });
  assertEquals(d.route_holds.repair_batches.length, 1);
  assertEquals(d.stranded_claude_batches.batch_ids, ["stranded"]); // repair batch excluded
});
