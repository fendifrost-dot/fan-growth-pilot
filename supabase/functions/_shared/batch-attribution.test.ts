/**
 * Batch drafted_by attribution — creation, spoof rejection, idempotency, backfill.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUTHENTICATED_BATCH_ACTORS,
  buildServerInventoryAttr,
  inventoryAttrFromAuthenticatedActor,
  planBatchDraftedByBackfill,
} from "./batch-attribution.ts";
import {
  createPlaylistDraftInventory,
  playlistDiscoveryActor,
} from "./playlist-discovery-mcp.ts";
import { inventoryIdempotencyKey } from "./playlist-discovery-ops.ts";
import { stripSpoofedAttribution } from "./ops-actors.ts";

type Row = Record<string, unknown>;

function stubSb(tables: Record<string, Row[]>): // deno-lint-ignore no-explicit-any
any {
  return {
    from: (table: string) => {
      if (!tables[table]) tables[table] = [];
      let filters: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | null = null;
      const apply = () =>
        tables[table].filter((r) =>
          Object.entries(filters).every(([k, v]) => String(r[k]) === String(v))
        );
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.insert = (row: Row | Row[]) => {
        mode = "insert";
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) {
          tables[table].push({ id: r.id ?? crypto.randomUUID(), ...r });
        }
        payload = list[0] ?? null;
        return chain;
      };
      chain.update = (row: Row) => {
        mode = "update";
        payload = row;
        return chain;
      };
      chain.delete = () => {
        mode = "delete";
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      };
      chain.in = () => chain;
      chain.is = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: apply()[0] ?? null, error: null });
      chain.single = () => {
        if (mode === "update" && payload) {
          const matched = apply();
          for (const r of matched) Object.assign(r, payload);
          return Promise.resolve({
            data: matched[0] ?? null,
            error: matched[0] ? null : { message: "nf" },
          });
        }
        const hit = apply()[0];
        return Promise.resolve({ data: hit ?? null, error: hit ? null : { message: "nf" } });
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (mode === "update" && payload) {
          const matched = apply();
          for (const r of matched) Object.assign(r, payload);
        }
        if (mode === "delete") {
          const matched = apply();
          tables[table] = tables[table].filter((r) => !matched.includes(r));
        }
        return Promise.resolve(resolve({ data: apply(), error: null }));
      };
      return chain;
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "agh_mcp_lookup_inventory_pair") {
        const key =
          `${args.p_track_id}:${args.p_playlist_id}:${args.p_channel}:${args.p_song_dna_version_id}`;
        const drafts = (tables.outreach_drafts ?? []).filter((r) =>
          r.ops_idempotency_key === key && ["pending", "approved"].includes(String(r.status))
        );
        const recs = (tables.agh_handoff_records ?? []).filter((r) =>
          String(r.track_id) === String(args.p_track_id) &&
          String(r.playlist_target_id) === String(args.p_playlist_id) &&
          String(r.submission_channel) === String(args.p_channel) &&
          String(r.song_dna_version_id) === String(args.p_song_dna_version_id) &&
          !["REJECTED_BY_GROK", "IMPORTED_TO_AGH"].includes(String(r.queue_state))
        );
        if (!drafts.length && !recs.length) {
          return { data: { ok: true, found: false, idempotency_key: key }, error: null };
        }
        return {
          data: {
            ok: true,
            found: true,
            idempotency_key: key,
            outreach_draft_id: drafts[0]?.id ?? recs[0]?.outreach_draft_id ?? null,
            draft_status: drafts[0]?.status ?? null,
            handoff_record_id: recs[0]?.id ?? null,
            batch_id: recs[0]?.batch_id ?? null,
          },
          error: null,
        };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
    _tables: tables,
  };
}

function inventoryFixture() {
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const playlistId = "0DAtAjCytSoXd6T42mP0AT";
  const tables: Record<string, Row[]> = {
    tracks: [{ id: trackId, name: "Song", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      short_pitch: "server pitch",
      primary_genre: "rap",
    }],
    playlist_targets: [{
      playlist_id: playlistId,
      contact_method: "email",
      submission_method: "email",
      path_verified: true,
      verification_status: "auto_verified",
      curator_email: "ok@curator.test",
      lane: "rap_general",
    }],
    outreach_drafts: [],
    agh_handoff_records: [],
    agh_handoff_batches: [],
  };
  return { trackId, dnaId, playlistId, tables };
}

Deno.test("server inventory attr stamps drafted_by from authenticated Claude actor", () => {
  const ops = playlistDiscoveryActor();
  const attr = buildServerInventoryAttr(ops);
  assertEquals(attr.discovered_by, "claude_playlist_discovery");
  assertEquals(attr.drafted_by, "claude_playlist_discovery");
  assertEquals(attr.drafted_by_label, "claude_playlist_discovery");
  assert(AUTHENTICATED_BATCH_ACTORS.has(attr.drafted_by));
});

Deno.test("caller drafted_by spoof is stripped and ignored for inventory attr", () => {
  const ops = playlistDiscoveryActor();
  const body = {
    track_id: "t1",
    drafted_by: "fendi",
    drafted_by_label: "spoofed_fendi",
    discovered_by: "human_admin",
  };
  const cleaned = stripSpoofedAttribution(body);
  assertEquals(cleaned.drafted_by, undefined);
  assertEquals(cleaned.discovered_by, undefined);
  const attr = inventoryAttrFromAuthenticatedActor(ops, body);
  assertEquals(attr.drafted_by, "claude_playlist_discovery");
  assertEquals(attr.discovered_by, "claude_playlist_discovery");
  assertEquals(attr.drafted_by_label, "claude_playlist_discovery");
});

Deno.test("authenticated Claude inventory persist receives batch drafted_by attr", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, dnaId, playlistId, tables } = inventoryFixture();
  let capturedAttr: Row | null = null;

  const res = await createPlaylistDraftInventory(
    stubSb(tables),
    ops,
    {
      track_id: trackId,
      accepted_candidate_ids: [playlistId],
      drafted_by: "fendi",
      drafted_by_label: "spoof",
    },
    {
      composeDraft: async () => ({
        status: 200,
        data: {
          ok: true,
          composed: true,
          persist: false,
          channel: "email",
          subject: "S",
          body: "server pitch",
          recipient: "ok@curator.test",
          track_name: "Song",
          pitch_copy_source: "song_dna_versions.short_pitch",
          pitch_copy_hash: "h",
          generated_by: "claude_playlist_discovery",
          metadata: {},
        },
      }),
      persistInventory: async (_sb, args) => {
        capturedAttr = args.attr as Row;
        const key = inventoryIdempotencyKey(trackId, playlistId, "email", dnaId);
        tables.outreach_drafts.push({
          id: "d1",
          status: "pending",
          ops_idempotency_key: key,
          body: "server pitch",
        });
        // Simulate fixed RPC: batch gets drafted_by from server attr.
        tables.agh_handoff_batches.push({
          id: "b1",
          record_count: 1,
          queue_state: "CLAUDE_BATCH_READY",
          discovered_by: args.attr.discovered_by,
          drafted_by: args.attr.drafted_by,
          drafted_by_label: args.attr.drafted_by_label,
        });
        tables.agh_handoff_records.push({
          id: "r1",
          batch_id: "b1",
          playlist_target_id: playlistId,
          drafted_by: args.attr.drafted_by,
          discovered_by: args.attr.discovered_by,
        });
        return {
          data: {
            ok: true,
            idempotent: false,
            batch_id: "b1",
            inserted: 1,
            record_count: 1,
            email_drafts: [{ playlist_id: playlistId, outreach_draft_id: "d1" }],
            manual_packets: [],
            items: [{
              playlist_id: playlistId,
              channel: "email",
              outreach_draft_id: "d1",
              handoff_record_id: "r1",
              batch_id: "b1",
              reused: false,
            }],
          },
          error: null,
        };
      },
    },
  );

  assertEquals(res.status, 200, JSON.stringify(res.data));
  assert(capturedAttr);
  assertEquals(capturedAttr!.drafted_by, "claude_playlist_discovery");
  assertEquals(capturedAttr!.discovered_by, "claude_playlist_discovery");
  assertEquals(capturedAttr!.drafted_by_label, "claude_playlist_discovery");
  assertEquals(res.data.drafted_by, "claude_playlist_discovery");
  assertEquals(tables.agh_handoff_batches[0].drafted_by, "claude_playlist_discovery");
  assertEquals(tables.agh_handoff_records[0].drafted_by, "claude_playlist_discovery");
});

Deno.test("inventory retry/idempotent reuse does not invent a second batch", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, dnaId, playlistId, tables } = inventoryFixture();
  const key = inventoryIdempotencyKey(trackId, playlistId, "email", dnaId);
  tables.outreach_drafts.push({
    id: "existing-draft",
    status: "pending",
    ops_idempotency_key: key,
    track_id: trackId,
    playlist_id: playlistId,
    channel: "email",
  });
  tables.agh_handoff_batches.push({
    id: "existing-batch",
    queue_state: "CLAUDE_BATCH_READY",
    discovered_by: "claude_playlist_discovery",
    drafted_by: "claude_playlist_discovery",
    record_count: 1,
  });
  tables.agh_handoff_records.push({
    id: "existing-rec",
    batch_id: "existing-batch",
    track_id: trackId,
    playlist_target_id: playlistId,
    submission_channel: "email",
    song_dna_version_id: dnaId,
    outreach_draft_id: "existing-draft",
    queue_state: "CLAUDE_BATCH_READY",
    drafted_by: "claude_playlist_discovery",
    discovered_by: "claude_playlist_discovery",
  });

  let persistCalls = 0;
  const res = await createPlaylistDraftInventory(
    stubSb(tables),
    ops,
    { track_id: trackId, accepted_candidate_ids: [playlistId] },
    {
      composeDraft: async () => {
        throw new Error("compose should not run on full reuse");
      },
      persistInventory: async () => {
        persistCalls += 1;
        return { data: null, error: { message: "should not persist" } };
      },
    },
  );

  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.idempotent, true);
  assertEquals(res.data.batch_id, "existing-batch");
  assertEquals(res.data.drafted_by, "claude_playlist_discovery");
  assertEquals(persistCalls, 0);
  assertEquals(tables.agh_handoff_batches.length, 1);
  assertEquals(tables.agh_handoff_batches[0].queue_state, "CLAUDE_BATCH_READY");
});

Deno.test("safe backfill updates unambiguous Claude batches only", () => {
  const plan = planBatchDraftedByBackfill(
    [
      {
        id: "b-ok",
        drafted_by: null,
        batch_kind: "playlist",
        queue_state: "CLAUDE_BATCH_READY",
      },
      {
        id: "b-already",
        drafted_by: "claude_playlist_discovery",
        batch_kind: "playlist",
        queue_state: "AWAITING_GROK_REVIEW",
      },
      {
        id: "b-mixed",
        drafted_by: null,
        batch_kind: "playlist",
        queue_state: "CLAUDE_BATCH_READY",
      },
      {
        id: "b-empty",
        drafted_by: null,
        batch_kind: "playlist",
        queue_state: "CLAUDE_BATCH_READY",
      },
      {
        id: "b-anon",
        drafted_by: null,
        batch_kind: "playlist",
        queue_state: "CLAUDE_BATCH_READY",
      },
    ],
    [
      {
        batch_id: "b-ok",
        drafted_by: "claude_playlist_discovery",
        drafted_by_label: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
      {
        batch_id: "b-ok",
        drafted_by: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
      {
        batch_id: "b-already",
        drafted_by: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
      {
        batch_id: "b-mixed",
        drafted_by: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
      {
        batch_id: "b-mixed",
        drafted_by: "fendi",
        discovered_by: "fendi",
      },
      {
        batch_id: "b-anon",
        drafted_by: "anonymous",
        discovered_by: "anonymous",
      },
    ],
  );

  assertEquals(plan.updates.length, 1);
  assertEquals(plan.updates[0].batch_id, "b-ok");
  assertEquals(plan.updates[0].drafted_by, "claude_playlist_discovery");
  assertEquals(plan.updates[0].queue_state, "CLAUDE_BATCH_READY");

  assertEquals(plan.reconciliation.length, 3);
  const byId = Object.fromEntries(plan.reconciliation.map((r) => [r.batch_id, r]));
  assertEquals(byId["b-mixed"].reason, "mixed_record_actors");
  assertEquals(byId["b-empty"].reason, "no_record_actor");
  assertEquals(byId["b-anon"].reason, "unauthenticated_actor");
});

Deno.test("backfill never rewrites existing drafted_by or non-playlist batches", () => {
  const plan = planBatchDraftedByBackfill(
    [
      {
        id: "sync-1",
        drafted_by: null,
        batch_kind: "sync",
        queue_state: "CLAUDE_BATCH_READY",
      },
      {
        id: "set-1",
        drafted_by: "claude",
        batch_kind: "playlist",
        queue_state: "GROK_REVIEWED",
      },
    ],
    [
      {
        batch_id: "sync-1",
        drafted_by: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
      {
        batch_id: "set-1",
        drafted_by: "claude_playlist_discovery",
        discovered_by: "claude_playlist_discovery",
      },
    ],
  );
  assertEquals(plan.updates.length, 0);
  assertEquals(plan.reconciliation.length, 0);
});
