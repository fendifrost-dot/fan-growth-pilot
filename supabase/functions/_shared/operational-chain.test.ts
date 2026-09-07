/**
 * Operational-chain handler tests (a–h):
 * a) wrong-song approved DNA rejected
 * b) stale DNA rejected
 * c) incompatible lane rejected
 * d) failed IG validation writes nothing
 * e) manual submission without APPROVED_FOR_SEND fails
 * f) transition races cannot skip/overwrite state
 * g) Claude cannot complete Grok work
 * h) Grok cannot complete Claude discovery work
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canTransitionHandoff,
  HANDOFF_TRANSITIONS,
  authorizeHandoffState,
  markManualFormSubmitted,
  advanceHandoffBatch,
} from "./handoff-queues.ts";
import { authorizeStationOperator } from "./chicago-time.ts";
import { resolveOpsActor } from "./ops-actors.ts";
import { assertPacketDnaEnvelope, buildInstagramDmPacket, runMultichannelAction } from "./multichannel-path.ts";
import { resolveCurrentApprovedDna, enforceTrackDnaLaneEnvelope } from "./track-dna-envelope.ts";
import type { Actor } from "./outreach-auth.ts";

type Row = Record<string, unknown>;

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test", { headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

/** Minimal PostgREST-ish stub with write tracking. */
function stubSb(tables: Record<string, Row[]>, writes: { table: string; op: string; row: Row }[] = []) {
  const from = (table: string) => {
    let rows = (tables[table] ?? []).map((r) => ({ ...r }));
    let filters: Record<string, unknown> = {};
    let mode: "select" | "update" | "insert" = "select";
    let payload: Row | null = null;
    const applyFilters = () =>
      rows.filter((r) => Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)));
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        const hit = applyFilters()[0] ?? null;
        return { data: hit, error: null };
      },
      single: async () => {
        const hit = applyFilters()[0];
        return hit
          ? { data: hit, error: null }
          : { data: null, error: { message: "no row" } };
      },
      insert: (row: Row) => {
        mode = "insert";
        payload = row;
        writes.push({ table, op: "insert", row });
        return chain;
      },
      update: (row: Row) => {
        mode = "update";
        payload = row;
        return chain;
      },
      rpc: async () => ({ data: null, error: { message: "Could not find the function" } }),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === "update" && payload) {
          const hits = applyFilters();
          if (!hits.length) {
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          for (const h of hits) Object.assign(h, payload);
          writes.push({ table, op: "update", row: { ...payload } });
          // Also mutate backing table
          const backing = tables[table] ?? [];
          for (const b of backing) {
            if (Object.entries(filters).every(([k, v]) => String(b[k]) === String(v))) {
              Object.assign(b, payload);
            }
          }
          return Promise.resolve({ data: hits, error: null }).then(resolve);
        }
        if (mode === "insert" && payload) {
          const row = { id: crypto.randomUUID(), ...payload };
          (tables[table] ??= []).push(row);
          return Promise.resolve({ data: [row], error: null }).then(resolve);
        }
        return Promise.resolve({ data: applyFilters(), error: null, count: applyFilters().length }).then(resolve);
      },
    };
    // Make update().eq().select().maybeSingle work
    (chain as { select: () => unknown }).select = (_c?: string) => {
      if (mode === "update") {
        return {
          maybeSingle: async () => {
            const hits = applyFilters();
            if (!hits.length || !payload) return { data: null, error: null };
            for (const h of hits) Object.assign(h, payload);
            writes.push({ table, op: "update", row: { ...payload } });
            const backing = tables[table] ?? [];
            for (const b of backing) {
              if (Object.entries(filters).every(([k, v]) => String(b[k]) === String(v))) {
                Object.assign(b, payload);
              }
            }
            return { data: hits[0], error: null };
          },
          single: async () => {
            const r = await (chain as { select: () => { maybeSingle: () => Promise<{ data: Row | null }> } })
              .select().maybeSingle();
            return r.data ? { data: r.data, error: null } : { data: null, error: { message: "missing" } };
          },
        };
      }
      return chain;
    };
    return chain;
  };
  return {
    from,
    rpc: async (_name: string, _args: Record<string, unknown>) => ({
      data: null,
      error: { message: "Could not find the function advance_agh_handoff_batch" },
    }),
  } as unknown as Parameters<typeof runMultichannelAction>[2];
}

const TRACK = {
  id: "track-a",
  name: "Song A",
  short_pitch: null,
  pitch_angle: null,
  approved_song_dna_version_id: "dna-a",
};

const DNA_A = {
  id: "dna-a",
  track_id: "track-a",
  short_pitch: "Approved pitch for Song A",
  approval_state: "approved",
  approved_lanes: ["rap_general"],
  excluded_lanes: ["house_club"],
  primary_genre: "rap",
};

const DNA_OTHER = {
  id: "dna-other",
  track_id: "track-other",
  short_pitch: "Other song pitch",
  approval_state: "approved",
  approved_lanes: ["rap_general"],
  excluded_lanes: [],
  primary_genre: "rap",
};

const DNA_STALE = {
  id: "dna-stale",
  track_id: "track-a",
  short_pitch: "Old pitch",
  approval_state: "approved",
  approved_lanes: ["rap_general"],
  excluded_lanes: [],
  primary_genre: "rap",
};

const PL_RAP = {
  playlist_id: "pl-rap",
  lane: "rap_general",
  verification_status: "auto_verified",
  playlist_name: "Rap List",
  path_verified: true,
};

const PL_HOUSE = {
  playlist_id: "pl-house",
  lane: "house_club",
  verification_status: "auto_verified",
  playlist_name: "House List",
  path_verified: true,
};

Deno.test("a) wrong-song approved DNA is rejected", async () => {
  const sb = stubSb({
    tracks: [TRACK],
    song_dna_versions: [DNA_A, DNA_OTHER],
    playlist_targets: [PL_RAP],
    outreach_decision_shadow_log: [],
  });
  const resolved = await resolveCurrentApprovedDna(sb as never, {
    trackId: "track-a",
    callerSongDnaVersionId: "dna-other",
  });
  assertEquals(resolved.ok, false);
  assert(resolved.errors.includes("song_dna_not_current"));

  // Even if caller omits and somehow points at other DNA via id lookup path —
  // enforceTrackDnaLaneEnvelope always uses current pointer.
  const env = await enforceTrackDnaLaneEnvelope(sb as never, {
    route: "test",
    trackId: "track-a",
    playlistId: "pl-rap",
    callerSongDnaVersionId: "dna-other",
  });
  assertEquals(env.ok, false);
  assert(env.errors.includes("song_dna_not_current"));
});

Deno.test("b) stale DNA is rejected", async () => {
  const sb = stubSb({
    tracks: [TRACK],
    song_dna_versions: [DNA_A, DNA_STALE],
    playlist_targets: [PL_RAP],
    outreach_decision_shadow_log: [],
  });
  const resolved = await resolveCurrentApprovedDna(sb as never, {
    trackId: "track-a",
    callerSongDnaVersionId: "dna-stale",
  });
  assertEquals(resolved.ok, false);
  assert(resolved.errors.includes("song_dna_not_current"));
});

Deno.test("c) incompatible lane is rejected", async () => {
  const sb = stubSb({
    tracks: [TRACK],
    song_dna_versions: [DNA_A],
    playlist_targets: [PL_HOUSE],
    outreach_decision_shadow_log: [],
    playlist_lanes: [],
  });
  const env = await enforceTrackDnaLaneEnvelope(sb as never, {
    route: "test",
    trackId: "track-a",
    playlistId: "pl-house",
  });
  assertEquals(env.ok, false);
  assert(
    env.errors.includes("dna_excluded_lane") || env.errors.includes("dna_lane_not_approved"),
  );
});

Deno.test("d) failed IG validation writes nothing", async () => {
  await withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, async () => {
    const writes: { table: string; op: string; row: Row }[] = [];
    const tables: Record<string, Row[]> = {
      tracks: [TRACK],
      song_dna_versions: [DNA_A],
      playlist_targets: [{ ...PL_HOUSE, ig_dm_draft: null }],
      outreach_decision_shadow_log: [],
      playlist_lanes: [],
    };
    const sb = stubSb(tables, writes);
    const res = await runMultichannelAction(
      "build_instagram_dm_draft",
      {
        playlist_id: "pl-house",
        track_id: "track-a",
        draft_body: "SHOULD NOT PERSIST",
      },
      sb,
      null,
      req({ "x-claude-agent-secret": "claude-secret" }),
    );
    assertEquals(res.status, 422);
    assertEquals(res.data.persisted, false);
    const igWrites = writes.filter((w) => w.table === "playlist_targets" && w.op === "update");
    assertEquals(igWrites.length, 0);
    assertEquals(tables.playlist_targets[0].ig_dm_draft, null);
  });
});

Deno.test("e) manual submission without APPROVED_FOR_SEND fails", async () => {
  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, async () => {
    const sb = stubSb({
      agh_handoff_records: [{
        id: "rec-1",
        queue_state: "AWAITING_GROK_REVIEW",
        track_id: "track-a",
        playlist_target_id: "pl-rap",
        song_dna_version_id: "dna-a",
      }],
    });
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    const res = await markManualFormSubmitted(sb as never, { handoff_record_id: "rec-1" }, grok);
    assertEquals(res.status, 422);
    assertEquals(res.data.code, "not_approved_for_send");
  });
});

Deno.test("f) transition races cannot skip/overwrite — shortcuts removed + CAS conflict", async () => {
  // No shortcut CLAUDE_BATCH_READY → AWAITING_GROK_REVIEW or → APPROVED
  assertEquals(canTransitionHandoff("CLAUDE_BATCH_READY", "AWAITING_GROK_REVIEW"), false);
  assertEquals(canTransitionHandoff("CLAUDE_BATCH_READY", "APPROVED_FOR_SEND"), false);
  assertEquals(canTransitionHandoff("AWAITING_GROK_REVIEW", "APPROVED_FOR_SEND"), false);
  assertEquals(HANDOFF_TRANSITIONS.CLAUDE_BATCH_READY, ["CLAUDE_PLAYLIST_COMPLETE"]);
  assertEquals(HANDOFF_TRANSITIONS.AWAITING_GROK_REVIEW, ["GROK_REVIEWED"]);
  assertEquals(HANDOFF_TRANSITIONS.GROK_REVIEWED.includes("APPROVED_FOR_SEND"), true);

  await withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, async () => {
    const tables: Record<string, Row[]> = {
      agh_handoff_batches: [{
        id: "batch-1",
        queue_state: "GROK_REVIEWED",
        discovered_by: "claude",
      }],
      agh_handoff_records: [{ id: "r1", batch_id: "batch-1", queue_state: "GROK_REVIEWED" }],
    };
    const sb = stubSb(tables);
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));

    // Race: another request already moved state before our CAS update.
    // Simulate by mutating after load would see GROK_REVIEWED — stub CAS uses eq filters.
    // First call loads GROK_REVIEWED; we mutate mid-flight by wrapping rpc-miss fallback.
    // Direct conflict via expected-state filter: force update against stale from.
    tables.agh_handoff_batches[0].queue_state = "APPROVED_FOR_SEND";
    const skip = await advanceHandoffBatch(
      sb as never,
      { batch_id: "batch-1", queue_state: "REJECTED_BY_GROK" },
      grok,
    );
    assertEquals(skip.status, 422);
    assertEquals(skip.data.code, "illegal_transition");

    // True CAS: from GROK_REVIEWED → APPROVED, but row already APPROVED after concurrent write.
    tables.agh_handoff_batches[0].queue_state = "GROK_REVIEWED";
    const racingSb = {
      ...stubSb(tables),
      rpc: async () => ({ data: null, error: { message: "Could not find the function advance_agh_handoff_batch" } }),
      from: (table: string) => {
        const base = stubSb(tables).from(table) as Record<string, unknown>;
        if (table !== "agh_handoff_batches") return base;
        let filters: Record<string, unknown> = {};
        let payload: Row | null = null;
        let mode = "select";
        const chain: Record<string, unknown> = {
          select: (_c?: string) => {
            if (mode === "update") {
              return {
                maybeSingle: async () => {
                  // Concurrent writer wins before CAS.
                  tables.agh_handoff_batches[0].queue_state = "APPROVED_FOR_SEND";
                  const hits = (tables.agh_handoff_batches ?? []).filter((r) =>
                    Object.entries(filters).every(([k, v]) => String(r[k]) === String(v))
                  );
                  if (!hits.length || !payload) return { data: null, error: null };
                  return { data: hits[0], error: null };
                },
              };
            }
            return chain;
          },
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            return chain;
          },
          update: (row: Row) => {
            mode = "update";
            payload = row;
            return chain;
          },
          maybeSingle: async () => {
            const hit = (tables.agh_handoff_batches ?? []).find((r) =>
              Object.entries(filters).every(([k, v]) => String(r[k]) === String(v))
            ) ?? null;
            return { data: hit, error: null };
          },
        };
        return chain;
      },
    };
    const race = await advanceHandoffBatch(
      racingSb as never,
      { batch_id: "batch-1", queue_state: "APPROVED_FOR_SEND" },
      grok,
    );
    assertEquals(race.status, 409);
    assertEquals(race.data.code, "conflict");
  });
});

Deno.test("g) Claude cannot complete Grok work", () => {
  assert(
    authorizeStationOperator("grok_playlist_review", "claude", "complete") != null,
  );
  assert(
    authorizeStationOperator("grok_playlist_send", "claude", "complete") != null,
  );
  assert(
    authorizeStationOperator("grok_playlist_review", "scheduler", "complete") != null,
  );
  withEnv({ CLAUDE_AGENT_SECRET: "claude-secret" }, () => {
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": "claude-secret" }));
    assert(authorizeHandoffState(claude, "APPROVED_FOR_SEND") != null);
    assert(authorizeHandoffState(claude, "GROK_REVIEWED") != null);
  });
});

Deno.test("h) Grok cannot complete Claude discovery work", () => {
  assert(
    authorizeStationOperator("playlist_discovery_begin", "grok_playlist_control", "complete") != null,
  );
  assert(
    authorizeStationOperator("playlist_tranche_final", "grok_playlist_control", "complete") != null,
  );
  assert(
    authorizeStationOperator("sync_batch_ready", "grok_playlist_control", "resume") != null,
  );
  // Scheduler may start Claude stations but not complete them
  assertEquals(authorizeStationOperator("playlist_discovery_begin", "scheduler", "start"), null);
  assert(authorizeStationOperator("playlist_discovery_begin", "scheduler", "complete") != null);
});

Deno.test("packet envelope requires track_id + DNA", () => {
  assert(assertPacketDnaEnvelope({ song_dna_version_id: "x" }) != null);
  assert(assertPacketDnaEnvelope({ track_id: "t1" }) != null);
  assertEquals(
    assertPacketDnaEnvelope({ track_id: "t1", song_dna_version_id: "dna-a" }),
    null,
  );
  const pkt = buildInstagramDmPacket({ playlist_id: "p" }, "hi", {
    track_id: "t1",
    song_dna_version_id: "dna-a",
  });
  assertEquals(pkt.track_id, "t1");
  assertEquals(pkt.song_dna_version_id, "dna-a");
});
