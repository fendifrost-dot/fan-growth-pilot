/**
 * Multi-batch CLAUDE_BATCH_READY advancement repair.
 *
 * 1. One tranche completion advances EVERY track-specific output batch to
 *    AWAITING_GROK_REVIEW — no batch is stranded because it was not "primary".
 * 2. Stranded Claude-owned batches can be advanced independently of any station run
 *    (no manual CoS clearance), and packet contents are never rewritten.
 * 3. Completed station records are immutable.
 * 4. Spotify identity can never collapse several playlists into one target via source_url.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { completeClaudePlaylistStation, playlistDiscoveryActor } from "./playlist-discovery-mcp.ts";
import { advanceClaudeReadyBatches } from "./handoff-queues.ts";
import { normalizeSpotifyPlaylistIdentity } from "./discovery-utils.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>) {
  const rpc = (name: string, args: Record<string, unknown>) => {
    if (name !== "advance_agh_handoff_batch") {
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    }
    const batch = (tables.agh_handoff_batches ?? []).find(
      (b) => String(b.id) === String(args.p_batch_id),
    );
    if (!batch) return Promise.resolve({ data: null, error: { message: "not found" } });
    if (String(batch.queue_state) !== String(args.p_expected_state)) {
      return Promise.resolve({
        data: { ok: false, code: "conflict", error: "state_mismatch" },
        error: null,
      });
    }
    batch.queue_state = String(args.p_next_state);
    Object.assign(batch, (args.p_stamps as Row) ?? {});
    return Promise.resolve({ data: { ok: true, batch }, error: null });
  };

  const from = (table: string) => {
    if (!tables[table]) tables[table] = [];
    const filters: Record<string, unknown> = {};
    const inFilters: { col: string; vals: string[] }[] = [];
    let mode: "select" | "update" = "select";
    let payload: Row | null = null;
    const match = (r: Row) =>
      Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)) &&
      inFilters.every((f) => f.vals.map(String).includes(String(r[f.col])));
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    };
    chain.in = (col: string, vals: unknown[]) => {
      inFilters.push({ col, vals: (vals ?? []).map(String) });
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.update = (row: Row) => {
      mode = "update";
      payload = row;
      return chain;
    };
    chain.maybeSingle = () => {
      const hit = tables[table].find(match) ?? null;
      return Promise.resolve({ data: hit, error: null });
    };
    chain.single = () => {
      if (mode === "update" && payload) {
        const idx = tables[table].findIndex(match);
        if (idx < 0) return Promise.resolve({ data: null, error: { message: "missing" } });
        tables[table][idx] = { ...tables[table][idx], ...payload };
        return Promise.resolve({ data: tables[table][idx], error: null });
      }
      const hit = tables[table].find(match) ?? null;
      return Promise.resolve({ data: hit, error: hit ? null : { message: "missing" } });
    };
    chain.then = (
      resolve: (v: { data: Row[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => Promise.resolve({ data: tables[table].filter(match), error: null }).then(resolve, reject);
    return chain;
  };

  return { rpc, from } as unknown as Parameters<typeof advanceClaudeReadyBatches>[0];
}

function claudeBatch(id: string, state = "CLAUDE_BATCH_READY"): Row {
  return {
    id,
    queue_state: state,
    batch_kind: "playlist",
    business_date_ct: "2026-09-10",
    discovered_by: "claude_playlist_discovery",
    discovered_by_label: "claude_playlist_discovery",
    payload: { packet_marker: id },
  };
}

Deno.test("tranche completion advances every track-specific output batch", async () => {
  const tables: Record<string, Row[]> = {
    daily_ops_station_runs: [{
      id: "run-multi",
      station_id: "playlist_tranche_final",
      business_date_ct: "2026-09-10",
      run_key: "primary",
      status: "running",
      owner_kind: "claude",
      actor_kind: "claude_playlist_discovery",
    }],
    agh_handoff_batches: [claudeBatch("batch-a"), claudeBatch("batch-b"), claudeBatch("batch-c")],
  };
  const sb = stubSb(tables);
  const res = await completeClaudePlaylistStation(sb, playlistDiscoveryActor(), {
    run_id: "run-multi",
    status: "completed",
    output_batch_id: "batch-a",
    output_batch_ids: ["batch-b", "batch-c"],
    drafts_created: 6,
  });
  assertEquals(res.status, 200, JSON.stringify(res.data));
  for (const b of tables.agh_handoff_batches) {
    assertEquals(b.queue_state, "AWAITING_GROK_REVIEW");
    // Packet contents untouched — only the queue state moved.
    assertEquals((b.payload as Row).packet_marker, b.id);
  }
});

Deno.test("stranded Claude batches advance independently of any station run", async () => {
  const tables: Record<string, Row[]> = {
    agh_handoff_batches: [
      claudeBatch("stranded-1"),
      claudeBatch("stranded-2", "CLAUDE_PLAYLIST_COMPLETE"),
      claudeBatch("already-reviewed", "GROK_REVIEWED"),
    ],
  };
  const sb = stubSb(tables);
  const res = await advanceClaudeReadyBatches(
    sb,
    { business_date_ct: "2026-09-10" },
    playlistDiscoveryActor(),
  );
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.advanced_count, 2);
  assertEquals(tables.agh_handoff_batches[0].queue_state, "AWAITING_GROK_REVIEW");
  assertEquals(tables.agh_handoff_batches[1].queue_state, "AWAITING_GROK_REVIEW");
  // Never walked backwards.
  assertEquals(tables.agh_handoff_batches[2].queue_state, "GROK_REVIEWED");
  assertEquals((tables.agh_handoff_batches[0].payload as Row).packet_marker, "stranded-1");
});

Deno.test("completed station records are immutable", async () => {
  const tables: Record<string, Row[]> = {
    daily_ops_station_runs: [{
      id: "run-done",
      station_id: "playlist_tranche_final",
      business_date_ct: "2026-09-10",
      run_key: "primary",
      status: "completed",
      completed_at: "2026-09-10T13:00:00.000Z",
      owner_kind: "claude",
      actor_kind: "claude_playlist_discovery",
      output_batch_id: "batch-a",
    }],
    agh_handoff_batches: [claudeBatch("batch-a", "AWAITING_GROK_REVIEW")],
  };
  const sb = stubSb(tables);
  const ops = playlistDiscoveryActor();

  const repeat = await completeClaudePlaylistStation(sb, ops, {
    run_id: "run-done",
    status: "completed",
    output_batch_id: "batch-a",
  });
  assertEquals(repeat.status, 200);
  assertEquals(repeat.data.noop, true);

  const rewrite = await completeClaudePlaylistStation(sb, ops, {
    run_id: "run-done",
    status: "failed",
  });
  assertEquals(rewrite.status, 409);
  assertEquals(rewrite.data.code, "station_run_immutable");
  assertEquals(tables.daily_ops_station_runs[0].status, "completed");
});

Deno.test("source_url can never collapse distinct playlists into one target", async () => {
  const blog = "https://blog.example.com/best-meditation-playlists-2026";
  assertEquals(normalizeSpotifyPlaylistIdentity("", blog), null);
  assertEquals(normalizeSpotifyPlaylistIdentity(null, blog), null);
  const a = normalizeSpotifyPlaylistIdentity("", "https://open.spotify.com/playlist/1DAtAjCytSoXd6T42mP0CJ?si=x");
  const b = normalizeSpotifyPlaylistIdentity("", "https://open.spotify.com/playlist/2DAtAjCytSoXd6T42mP0CJ");
  assert(a && b && a.playlist_id !== b.playlist_id);

  // The url-keyed identity fallback must not exist in the discovery path.
  const src = Deno.readTextFileSync(new URL("./playlist-discovery-mcp.ts", import.meta.url));
  assert(!src.includes("`url:${"), "url-keyed playlist identity fallback must be removed");
  assert(src.includes("unresolvable_playlist_identity"));
});
