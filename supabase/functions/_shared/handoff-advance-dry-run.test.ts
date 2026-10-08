/**
 * advance_claude_ready_batches must honor dry_run.
 *
 * Boolean true and the string "true" report what would move and write nothing.
 * Absent or false still advances CLAUDE_BATCH_READY / CLAUDE_PLAYLIST_COMPLETE
 * to AWAITING_GROK_REVIEW.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { advanceClaudeReadyBatches, runHandoffAction } from "./handoff-queues.ts";
import type { Actor } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

const INCIDENT_BATCH = "160e5a1c-a6c7-4720-840f-66384ed5d153";

type Write = { op: "rpc" | "insert" | "update" | "upsert" | "delete"; target: string };

function snapshot(tables: Record<string, Row[]>): string {
  return JSON.stringify(tables);
}

function stubSb(tables: Record<string, Row[]>) {
  const writes: Write[] = [];

  const rpc = (name: string, args: Record<string, unknown>) => {
    writes.push({ op: "rpc", target: name });
    if (name !== "advance_agh_handoff_batch") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    }
    const batch = (tables.agh_handoff_batches ?? []).find(
      (b) => String(b.id) === String(args.p_batch_id),
    );
    if (!batch || String(batch.queue_state) !== String(args.p_expected_state)) {
      return Promise.resolve({
        data: { ok: false, code: "conflict", error: "state_mismatch" },
        error: null,
      });
    }
    batch.queue_state = String(args.p_next_state);
    Object.assign(batch, (args.p_stamps as Row) ?? {});
    let recordsUpdated = 0;
    for (const rec of tables.agh_handoff_records ?? []) {
      if (String(rec.batch_id) !== String(args.p_batch_id)) continue;
      if (String(rec.queue_state) === "REJECTED_BY_GROK") continue;
      rec.queue_state = String(args.p_next_state);
      recordsUpdated += 1;
    }
    return Promise.resolve({
      data: { ok: true, batch, records_updated: recordsUpdated },
      error: null,
    });
  };

  const from = (table: string) => {
    if (!tables[table]) tables[table] = [];
    const filters: Record<string, unknown> = {};
    const inFilters: { col: string; vals: string[] }[] = [];
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    const match = (r: Row) =>
      Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)) &&
      inFilters.every((f) => f.vals.map(String).includes(String(r[f.col])));
    const chain: Record<string, unknown> = {};
    const back = () => chain;
    chain.select = back;
    chain.order = back;
    chain.limit = back;
    chain.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      inFilters.push({ col, vals: (vals ?? []).map(String) });
      return chain;
    };
    chain.insert = (row: Row | Row[]) => {
      mode = "insert";
      payload = row;
      writes.push({ op: "insert", target: table });
      return chain;
    };
    chain.upsert = (row: Row | Row[]) => {
      mode = "insert";
      payload = row;
      writes.push({ op: "upsert", target: table });
      return chain;
    };
    chain.update = (row: Row) => {
      mode = "update";
      payload = row;
      writes.push({ op: "update", target: table });
      return chain;
    };
    chain.delete = () => {
      mode = "delete";
      writes.push({ op: "delete", target: table });
      return chain;
    };
    const applyWrite = () => {
      if (mode === "insert" && payload) {
        const rows = Array.isArray(payload) ? payload : [payload];
        tables[table].push(...rows);
      } else if (mode === "update" && payload && !Array.isArray(payload)) {
        for (const row of tables[table]) {
          if (match(row)) Object.assign(row, payload);
        }
      } else if (mode === "delete") {
        tables[table] = tables[table].filter((row) => !match(row));
      }
    };
    chain.maybeSingle = () => {
      applyWrite();
      const hit = tables[table].find(match) ?? null;
      return Promise.resolve({ data: hit, error: null });
    };
    chain.single = () => chain.maybeSingle();
    chain.then = (
      resolve: (v: { data: Row[] | null; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      applyWrite();
      return Promise.resolve({ data: tables[table].filter(match), error: null }).then(resolve, reject);
    };
    return chain;
  };

  return {
    sb: { rpc, from } as unknown as Parameters<typeof advanceClaudeReadyBatches>[0],
    writes,
  };
}

function fixture(): Record<string, Row[]> {
  return {
    agh_handoff_batches: [
      {
        id: INCIDENT_BATCH,
        queue_state: "CLAUDE_BATCH_READY",
        batch_kind: "playlist",
        business_date_ct: "2026-10-08",
        discovered_by: "claude_playlist_discovery",
      },
      {
        id: "complete-1",
        queue_state: "CLAUDE_PLAYLIST_COMPLETE",
        batch_kind: "playlist",
        business_date_ct: "2026-10-08",
        discovered_by: "claude_playlist_discovery",
      },
      {
        id: "already-reviewed",
        queue_state: "GROK_REVIEWED",
        batch_kind: "playlist",
        business_date_ct: "2026-10-08",
        discovered_by: "claude_playlist_discovery",
      },
      {
        id: "held-1",
        queue_state: "CLAUDE_BATCH_READY",
        batch_kind: "playlist",
        business_date_ct: "2026-10-08",
        discovered_by: "claude_playlist_discovery",
      },
    ],
    agh_handoff_records: [
      { id: "r-move-1", batch_id: INCIDENT_BATCH, queue_state: "CLAUDE_BATCH_READY", packet: {} },
      { id: "r-move-2", batch_id: INCIDENT_BATCH, queue_state: "CLAUDE_BATCH_READY", packet: {} },
      { id: "r-rejected", batch_id: INCIDENT_BATCH, queue_state: "REJECTED_BY_GROK", packet: {} },
      { id: "r-complete", batch_id: "complete-1", queue_state: "CLAUDE_PLAYLIST_COMPLETE", packet: {} },
      {
        id: "r-held",
        batch_id: "held-1",
        queue_state: "CLAUDE_BATCH_READY",
        packet: { route_hold: { code: "missing_form_url" } },
      },
    ],
    agh_handoff_state_audit: [],
  };
}

const ACTOR: Actor = { kind: "claude_playlist_discovery" };

const BATCH_IDS = [INCIDENT_BATCH, "complete-1", "already-reviewed", "held-1", "missing-batch"];

function byId(rows: Row[], id: string): Row {
  const hit = rows.find((r) => r.id === id);
  if (!hit) throw new Error(`missing ${id}`);
  return hit;
}

Deno.test("dry_run true previews the advance and writes nothing", async () => {
  const tables = fixture();
  const before = snapshot(tables);
  const { sb, writes } = stubSb(tables);
  const res = await runHandoffAction(
    "advance_claude_ready_batches",
    { batch_ids: BATCH_IDS, dry_run: true },
    sb,
    ACTOR,
    null,
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.dry_run, true);
  assertEquals(res.data.advanced, []);
  assertEquals(res.data.advanced_count, 0);
  assertEquals(res.data.would_move_count, 2);
  assertEquals(res.data.would_move, [
    {
      batch_id: INCIDENT_BATCH,
      record_count: 2,
      from_status: "CLAUDE_BATCH_READY",
      to_status: "AWAITING_GROK_REVIEW",
    },
    {
      batch_id: "complete-1",
      record_count: 1,
      from_status: "CLAUDE_PLAYLIST_COMPLETE",
      to_status: "AWAITING_GROK_REVIEW",
    },
  ]);
  const skipped = res.data.skipped as Row[];
  assertEquals(
    skipped.map((s) => ({ batch_id: s.batch_id, from_status: s.from_status, reason: s.reason })),
    [
      { batch_id: "already-reviewed", from_status: "GROK_REVIEWED", reason: "not_claude_pending" },
      { batch_id: "held-1", from_status: "CLAUDE_BATCH_READY", reason: "route_hold_unresolved" },
    ],
  );
  assertEquals((res.data.failed as Row[]).map((f) => f.code), ["batch_not_found"]);
  assertEquals(writes, []);
  assertEquals(snapshot(tables), before);
  assertEquals(byId(tables.agh_handoff_batches, INCIDENT_BATCH).queue_state, "CLAUDE_BATCH_READY");
  assertEquals(byId(tables.agh_handoff_records, "r-move-1").queue_state, "CLAUDE_BATCH_READY");
  assertEquals(tables.agh_handoff_state_audit, []);
});

Deno.test("dry_run string 'true' is the same preview and still writes nothing", async () => {
  const tables = fixture();
  const before = snapshot(tables);
  const { sb, writes } = stubSb(tables);
  const res = await advanceClaudeReadyBatches(
    sb,
    { batch_ids: BATCH_IDS, dry_run: "true" },
    { kind: "claude_playlist_discovery", userId: null, label: "claude_playlist_discovery" },
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.dry_run, true);
  assertEquals(res.data.would_move_count, 2);
  assertEquals((res.data.would_move as Row[])[0].batch_id, INCIDENT_BATCH);
  assertEquals((res.data.would_move as Row[])[0].record_count, 2);
  assertEquals((res.data.would_move as Row[])[0].from_status, "CLAUDE_BATCH_READY");
  assertEquals((res.data.would_move as Row[])[0].to_status, "AWAITING_GROK_REVIEW");
  assertEquals(writes, []);
  assertEquals(snapshot(tables), before);
});

async function assertLiveAdvance(dryRun: unknown, includeFlag: boolean) {
  const tables = fixture();
  const { sb, writes } = stubSb(tables);
  const body: Record<string, unknown> = { batch_ids: BATCH_IDS };
  if (includeFlag) body.dry_run = dryRun;
  const res = await advanceClaudeReadyBatches(
    sb,
    body,
    { kind: "claude_playlist_discovery", userId: null, label: "claude_playlist_discovery" },
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.dry_run, false);
  assertEquals(res.data.advanced_count, 2);
  assertEquals(
    (res.data.advanced as Row[]).map((a) => a.batch_id),
    [INCIDENT_BATCH, "complete-1"],
  );
  for (const row of res.data.advanced as Row[]) {
    assertEquals(row.queue_state, "AWAITING_GROK_REVIEW");
  }
  assertEquals(byId(tables.agh_handoff_batches, INCIDENT_BATCH).queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(byId(tables.agh_handoff_batches, "complete-1").queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(byId(tables.agh_handoff_records, "r-move-1").queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(byId(tables.agh_handoff_records, "r-move-2").queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(byId(tables.agh_handoff_records, "r-complete").queue_state, "AWAITING_GROK_REVIEW");
  // Individually rejected records and held / already-reviewed batches stay put.
  assertEquals(byId(tables.agh_handoff_records, "r-rejected").queue_state, "REJECTED_BY_GROK");
  assertEquals(byId(tables.agh_handoff_batches, "held-1").queue_state, "CLAUDE_BATCH_READY");
  assertEquals(byId(tables.agh_handoff_batches, "already-reviewed").queue_state, "GROK_REVIEWED");
  assertEquals(writes.some((w) => w.op === "rpc" && w.target === "advance_agh_handoff_batch"), true);
  assertEquals((res.data.skipped as Row[]).map((s) => s.reason), [
    "not_claude_pending",
    "route_hold_unresolved",
  ]);
}

Deno.test("live advance still runs when dry_run is absent", async () => {
  await assertLiveAdvance(undefined, false);
});

Deno.test("live advance still runs when dry_run is false", async () => {
  await assertLiveAdvance(false, true);
});

Deno.test("live advance still runs when dry_run is the string 'false'", async () => {
  await assertLiveAdvance("false", true);
});
