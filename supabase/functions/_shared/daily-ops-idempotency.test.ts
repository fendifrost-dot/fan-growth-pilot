/**
 * In-memory idempotency + upstream continuity for daily station runs.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { startDailyStationRun, completeDailyStationRun } from "./daily-ops.ts";
import type { Actor } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

function mockSb(store: { runs: Row[] }) {
  const api = {
    from(table: string) {
      if (table !== "daily_ops_station_runs") {
        throw new Error(`unexpected table ${table}`);
      }
      let filters: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" = "select";
      let payload: Row | null = null;
      const chain: Record<string, unknown> = {
        select(_cols?: string) {
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => {
          const hit = store.runs.find((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v)
          );
          return { data: hit ?? null, error: null };
        },
        single: async () => {
          if (mode === "insert" && payload) {
            // unique race simulation
            const dup = store.runs.find(
              (r) =>
                r.station_id === payload!.station_id &&
                r.business_date_ct === payload!.business_date_ct &&
                r.run_key === payload!.run_key,
            );
            if (dup) {
              return { data: null, error: { message: "duplicate", code: "23505" } };
            }
            const row = { id: crypto.randomUUID(), ...payload };
            store.runs.push(row);
            return { data: row, error: null };
          }
          if (mode === "update" && payload) {
            const idx = store.runs.findIndex((r) =>
              Object.entries(filters).every(([k, v]) => r[k] === v)
            );
            if (idx < 0) return { data: null, error: { message: "missing" } };
            store.runs[idx] = { ...store.runs[idx], ...payload };
            return { data: store.runs[idx], error: null };
          }
          const hit = store.runs.find((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v)
          );
          return { data: hit ?? null, error: hit ? null : { message: "missing" } };
        },
        insert(row: Row) {
          mode = "insert";
          payload = row;
          filters = {};
          return chain;
        },
        update(row: Row) {
          mode = "update";
          payload = row;
          return chain;
        },
      };
      return chain;
    },
  };
  return api as unknown as Parameters<typeof startDailyStationRun>[0];
}

Deno.test("station retries are idempotent — resume same run, no duplicate", async () => {
  const store = { runs: [] as Row[] };
  const sb = mockSb(store);
  const actor: Actor = { kind: "anonymous" };
  const req = new Request("https://t", {
    headers: { "x-claude-agent-secret": "c" },
  });
  // Need Claude env for ownership
  Deno.env.set("CLAUDE_AGENT_SECRET", "c");
  try {
    const first = await startDailyStationRun(
      sb,
      { station_id: "playlist_discovery_begin", business_date_ct: "2026-09-07" },
      actor,
      req,
    );
    assertEquals(first.status, 200);
    assertEquals(first.data.created, true);
    const runId = (first.data.run as Row).id;

    const second = await startDailyStationRun(
      sb,
      { station_id: "playlist_discovery_begin", business_date_ct: "2026-09-07" },
      actor,
      req,
    );
    assertEquals(second.status, 200);
    assertEquals(second.data.resumed, true);
    assertEquals((second.data.run as Row).id, runId);
    assertEquals(store.runs.length, 1);
  } finally {
    Deno.env.delete("CLAUDE_AGENT_SECRET");
  }
});

Deno.test("later station consumes upstream output batch and records dependency failure", async () => {
  const store = {
    runs: [
      {
        id: "up-1",
        station_id: "playlist_discovery_begin",
        business_date_ct: "2026-09-07",
        run_key: "primary",
        status: "failed",
        output_batch_id: "batch-out-1",
        error_summary: "source_timeout",
        owner_kind: "claude",
      },
    ] as Row[],
  };
  const sb = mockSb(store);
  const actor: Actor = { kind: "anonymous" };
  Deno.env.set("CLAUDE_AGENT_SECRET", "c");
  try {
    const res = await startDailyStationRun(
      sb,
      { station_id: "playlist_tranche_first", business_date_ct: "2026-09-07" },
      actor,
      new Request("https://t", { headers: { "x-claude-agent-secret": "c" } }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.data.continue_safe_work, true);
    assertEquals(String(res.data.dependency_failure).includes("upstream_failed"), true);
    const run = res.data.run as Row;
    assertEquals(run.upstream_run_id, "up-1");
    assertEquals(run.input_batch_id, "batch-out-1");
  } finally {
    Deno.env.delete("CLAUDE_AGENT_SECRET");
  }
});

Deno.test("complete_daily_station_run updates metrics on existing row", async () => {
  const store = {
    runs: [
      {
        id: "run-9",
        station_id: "sync_batch_ready",
        business_date_ct: "2026-09-07",
        run_key: "primary",
        status: "running",
        owner_kind: "claude",
        actor_kind: "claude",
      },
    ] as Row[],
  };
  const sb = mockSb(store);
  Deno.env.set("CLAUDE_AGENT_SECRET", "c");
  try {
    const done = await completeDailyStationRun(
      sb,
      {
        run_id: "run-9",
        status: "partial",
        raw_discoveries: 10,
        unique_discoveries: 8,
        verified_targets: 5,
        drafts_created: 3,
        duplicates: 2,
        shortfall_reason: "saturation",
        output_batch_id: "batch-sync-1",
      },
      { kind: "anonymous" },
      new Request("https://t", { headers: { "x-claude-agent-secret": "c" } }),
    );
    assertEquals(done.status, 200);
    assertEquals((done.data.run as Row).status, "partial");
    assertEquals((done.data.run as Row).verified_targets, 5);
    assertEquals((done.data.run as Row).output_batch_id, "batch-sync-1");
  } finally {
    Deno.env.delete("CLAUDE_AGENT_SECRET");
  }
});

Deno.test("Grok cannot complete Claude station run", async () => {
  const store = {
    runs: [
      {
        id: "run-claude",
        station_id: "playlist_discovery_begin",
        business_date_ct: "2026-09-07",
        run_key: "primary",
        status: "running",
        owner_kind: "claude",
      },
    ] as Row[],
  };
  const sb = mockSb(store);
  Deno.env.set("GROK_PLAYLIST_CONTROL_SECRET", "g");
  try {
    const done = await completeDailyStationRun(
      sb,
      { run_id: "run-claude", status: "completed" },
      { kind: "anonymous" },
      new Request("https://t", { headers: { "x-grok-playlist-control-secret": "g" } }),
    );
    assertEquals(done.status, 403);
    assertEquals(done.data.code, "station_ownership");
  } finally {
    Deno.env.delete("GROK_PLAYLIST_CONTROL_SECRET");
  }
});
