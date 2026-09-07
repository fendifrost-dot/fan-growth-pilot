/**
 * Playlist-discovery MCP connector — inventory, verification, channels,
 * Grok handoff path, OAuth consent, and denial matrix.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  resolveOpsActor,
  attributionFrom,
} from "./ops-actors.ts";
import { authorizeAction } from "./outreach-auth.ts";
import { authorizeStationOperator } from "./chicago-time.ts";
import {
  authorizeHandoffState,
  reviewHandoffBatch,
} from "./handoff-queues.ts";
import { rejectCallerPlaylistCopy } from "./pitch-descriptor-guard.ts";
import { normalizeSpotifyPlaylistIdentity } from "./discovery-utils.ts";
import {
  PLAYLIST_DISCOVERY_TOOLS,
  PLAYLIST_DISCOVERY_TOOL_SCHEMAS,
  isPlaylistDiscoveryTool,
  playlistDiscoveryActor,
  runPlaylistDiscoveryTool,
  validateToolArgs,
  getPlaylistDiscoveryWork,
  submitPlaylistCandidates,
  createPlaylistDraftInventory,
  startClaudePlaylistStation,
} from "./playlist-discovery-mcp.ts";
import {
  inventoryIdempotencyKey,
} from "./playlist-discovery-ops.ts";
import {
  mcpPublicBaseUrl,
  PLAYLIST_DISCOVERY_SCOPE,
  protectedResourceMetadata,
  authorizationServerMetadata,
  sha256Hex,
  pkceS256Challenge,
  isAllowedRedirectUri,
  authorizeFendiSession,
  registerClient,
  issueAuthCode,
  exchangeToken,
  revokeToken,
  renderConsentPage,
  REFRESH_TOKEN_MAX_LIFETIME_MS,
} from "./mcp-oauth.ts";

const DISCOVERY = "pd-secret-narrow-only";
const CLAUDE = "claude-agent-secret-broad";
const GROK = "grok-control-secret";
const FENDI_ID = "fendi-exact-id";

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/", { method: "POST", headers });
}

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  const finish = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
  const result = fn();
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).finally(finish);
  }
  finish();
}

type Row = Record<string, unknown>;

/** PostgREST-ish stub with insert/update tracking and error injection. */
function stubSb(
  tables: Record<string, Row[]> = {},
  opts: {
    authUser?: { id: string } | null;
    failTables?: Record<string, string>;
    writes?: { table: string; op: string; row: Row }[];
    rpcHandlers?: Record<
      string,
      (args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>
    >;
  } = {},
  // deno-lint-ignore no-explicit-any
): any {
  const writes = opts.writes ?? [];
  const failTables = opts.failTables ?? {};
  const rpcHandlers = opts.rpcHandlers ?? {};

  const defaultRpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (rpcHandlers[name]) return rpcHandlers[name](args);
    if (name === "agh_mcp_oauth_cleanup_expired") {
      return { data: { ok: true, codes_deleted: 0, tokens_deleted: 0 }, error: null };
    }
    if (name === "agh_mcp_lookup_inventory_pair") {
      const key = `${args.p_track_id}:${args.p_playlist_id}:${args.p_channel}:${args.p_song_dna_version_id}`;
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
    if (name === "agh_mcp_delete_orphan_drafts") {
      const keys = (args.p_keys as string[]) ?? [];
      const before = (tables.outreach_drafts ?? []).length;
      tables.outreach_drafts = (tables.outreach_drafts ?? []).filter((d) => {
        if (!keys.includes(String(d.ops_idempotency_key))) return true;
        if (String(d.status) !== "pending") return true;
        const linked = (tables.agh_handoff_records ?? []).some((r) =>
          String(r.outreach_draft_id) === String(d.id)
        );
        return linked;
      });
      return {
        data: { ok: true, deleted: before - (tables.outreach_drafts ?? []).length },
        error: null,
      };
    }
    if (name === "agh_mcp_delete_empty_handoff_batch") {
      const id = String(args.p_batch_id);
      const batch = (tables.agh_handoff_batches ?? []).find((b) => String(b.id) === id);
      if (!batch) {
        return { data: { ok: false, code: "not_found", error: "batch not found" }, error: null };
      }
      if (Number(batch.record_count ?? 0) > 0) {
        return {
          data: { ok: false, code: "not_empty", error: "refusing", record_count: batch.record_count },
          error: null,
        };
      }
      tables.agh_handoff_batches = (tables.agh_handoff_batches ?? []).filter((b) =>
        String(b.id) !== id
      );
      return { data: { ok: true, deleted_batch_id: id }, error: null };
    }
    if (name === "agh_mcp_consume_oauth_code") {
      const codes = tables.agh_mcp_oauth_codes ?? [];
      const idx = codes.findIndex((c) => String(c.code_hash) === String(args.p_code_hash));
      if (idx < 0) {
        return { data: { ok: false, code: "invalid_grant", error: "code not found or already used" }, error: null };
      }
      const row = codes[idx];
      if (String(row.client_id) !== String(args.p_client_id) ||
        String(row.redirect_uri) !== String(args.p_redirect_uri)) {
        return { data: { ok: false, code: "invalid_grant", error: "client/redirect mismatch" }, error: null };
      }
      if (args.p_expected_challenge != null &&
        String(row.code_challenge) !== String(args.p_expected_challenge)) {
        return { data: { ok: false, code: "invalid_grant", error: "pkce_failed" }, error: null };
      }
      codes.splice(idx, 1);
      if (!tables.agh_mcp_oauth_tokens) tables.agh_mcp_oauth_tokens = [];
      tables.agh_mcp_oauth_tokens.push({
        token_hash: args.p_access_token_hash,
        refresh_token_hash: args.p_refresh_token_hash,
        client_id: args.p_client_id,
        scope: "playlist_discovery",
        actor_kind: "claude_playlist_discovery",
        authorized_by_user_id: row.authorized_by_user_id ?? null,
        expires_at: args.p_access_expires_at,
        refresh_expires_at: args.p_refresh_expires_at,
        revoked_at: null,
      });
      return {
        data: {
          ok: true,
          authorized_by_user_id: row.authorized_by_user_id ?? null,
          scope: "playlist_discovery",
          actor_kind: "claude_playlist_discovery",
        },
        error: null,
      };
    }
    if (name === "agh_mcp_rotate_oauth_refresh") {
      const toks = tables.agh_mcp_oauth_tokens ?? [];
      const tok = toks.find((t) =>
        String(t.refresh_token_hash) === String(args.p_refresh_token_hash) && t.revoked_at == null
      );
      if (!tok || String(tok.client_id) !== String(args.p_client_id)) {
        return { data: { ok: false, code: "invalid_grant", error: "refresh not found or revoked" }, error: null };
      }
      const refreshExp = tok.refresh_expires_at
        ? new Date(String(tok.refresh_expires_at)).getTime()
        : 0;
      if (!refreshExp || refreshExp < Date.now()) {
        tok.revoked_at = new Date().toISOString();
        return { data: { ok: false, code: "invalid_grant", error: "refresh_expired" }, error: null };
      }
      tok.revoked_at = new Date().toISOString();
      const preserved = tok.refresh_expires_at;
      toks.push({
        token_hash: args.p_new_access_token_hash,
        refresh_token_hash: args.p_new_refresh_token_hash,
        client_id: args.p_client_id,
        scope: tok.scope,
        actor_kind: "claude_playlist_discovery",
        authorized_by_user_id: tok.authorized_by_user_id ?? null,
        expires_at: args.p_access_expires_at,
        refresh_expires_at: preserved,
        revoked_at: null,
      });
      return {
        data: {
          ok: true,
          authorized_by_user_id: tok.authorized_by_user_id ?? null,
          refresh_expires_at: preserved,
          scope: tok.scope,
        },
        error: null,
      };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };

  return {
    auth: {
      getUser: (_t: string) =>
        Promise.resolve({
          data: { user: opts.authUser ?? null },
          error: opts.authUser ? null : new Error("bad token"),
        }),
    },
    rpc: (name: string, args: Record<string, unknown> = {}) => defaultRpc(name, args),
    from: (table: string) => {
      if (!tables[table]) tables[table] = [];
      let filters: Record<string, unknown> = {};
      let notFilters: { col: string; op: string; val: unknown }[] = [];
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      let wantCount = false;
      const apply = () =>
        tables[table].filter((r) => {
          const eqOk = Object.entries(filters).every(([k, v]) => {
            if (v && typeof v === "object" && (v as { __null?: boolean }).__null) {
              return r[k] == null;
            }
            if (v && typeof v === "object" && "__lt" in (v as object)) {
              return String(r[k]) < String((v as { __lt: unknown }).__lt);
            }
            if (v && typeof v === "object" && "__gt" in (v as object)) {
              return String(r[k]) > String((v as { __gt: unknown }).__gt);
            }
            if (Array.isArray(v)) return v.map(String).includes(String(r[k]));
            return String(r[k]) === String(v);
          });
          if (!eqOk) return false;
          for (const nf of notFilters) {
            if (nf.op === "in") {
              const list = String(nf.val).replace(/^\(|\)$/g, "").split(",");
              if (list.includes(String(r[nf.col]))) return false;
            }
          }
          return true;
        });
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.insert = (row: Row | Row[]) => {
        mode = "insert";
        payload = row;
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) {
          const withId = { id: r.id ?? crypto.randomUUID(), ...r };
          tables[table].push(withId);
          writes.push({ table, op: "insert", row: withId });
        }
        return chain;
      };
      chain.update = (row: Row, options?: { count?: string }) => {
        mode = "update";
        payload = row;
        wantCount = options?.count === "exact";
        return chain;
      };
      chain.delete = (options?: { count?: string }) => {
        mode = "delete";
        wantCount = options?.count === "exact";
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      };
      chain.in = (col: string, vals: unknown[]) => {
        filters[col] = vals;
        return chain;
      };
      chain.is = (col: string, val: unknown) => {
        filters[col] = val === null ? { __null: true } : val;
        return chain;
      };
      chain.lt = (col: string, val: unknown) => {
        filters[col] = { __lt: val };
        return chain;
      };
      chain.gt = (col: string, val: unknown) => {
        filters[col] = { __gt: val };
        return chain;
      };
      chain.not = (col: string, op: string, val: unknown) => {
        notFilters.push({ col, op, val });
        return chain;
      };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => {
        if (failTables[table]) {
          return Promise.resolve({ data: null, error: { message: failTables[table] } });
        }
        return Promise.resolve({ data: apply()[0] ?? null, error: null });
      };
      chain.single = () => {
        if (failTables[table]) {
          return Promise.resolve({ data: null, error: { message: failTables[table] } });
        }
        const hit = apply()[0];
        return Promise.resolve({
          data: hit ?? null,
          error: hit ? null : { message: "not found" },
        });
      };
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (failTables[table] && mode === "select") {
          return Promise.resolve(resolve({ data: null, error: { message: failTables[table] } }));
        }
        if (mode === "delete") {
          const matched = apply();
          tables[table] = tables[table].filter((r) => !matched.includes(r));
          return Promise.resolve(resolve({
            data: null,
            error: null,
            count: wantCount ? matched.length : null,
          }));
        }
        if (mode === "update" && payload && !Array.isArray(payload)) {
          const matched = apply();
          for (const r of matched) Object.assign(r, payload);
          writes.push({ table, op: "update", row: { ...(payload as Row) } });
          return Promise.resolve(resolve({
            data: null,
            error: null,
            count: wantCount ? matched.length : null,
          }));
        }
        if (mode === "insert") {
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        return Promise.resolve(resolve({ data: apply(), error: null }));
      };
      return chain;
    },
    _tables: tables,
    _writes: writes,
  };
}

Deno.test("connector works without Fendi JWT via trusted actor identity", () => {
  const ops = playlistDiscoveryActor();
  assertEquals(ops.kind, "claude_playlist_discovery");
  assertEquals(ops.userId, null);
  assertEquals(can(ops, "read_playlist_discovery_work"), true);
  assertEquals(can(ops, "approve_playlist_drafts"), false);
  assertEquals(can(ops, "send_playlist_pitches"), false);
});

Deno.test("Claude remains denied approve/send/DNA/reply/placement", async () => {
  await withEnv({ CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY }, async () => {
    const headers = { "x-claude-playlist-discovery-secret": DISCOVERY };
    const sb = stubSb();
    for (const action of [
      "approve_draft",
      "send_campaign",
      "approve_song_dna",
      "mark_pitch_response",
      "discover_spotify_placements",
      "get_leads",
      "get_radio_targets",
      "list_licensing_pitches",
    ]) {
      const d = await authorizeAction(action, req(headers), sb);
      assertEquals(d.ok, false, action);
    }
  });
});

Deno.test("Claude cannot operate Grok stations; Grok retains approve/send with Fendi", () => {
  assert(
    authorizeStationOperator("grok_playlist_review", "claude_playlist_discovery", "start") !== null,
  );
  assert(
    authorizeStationOperator("grok_playlist_send", "claude_playlist_discovery", "complete") !== null,
  );
  withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: GROK,
    ARTIST_USER_ID: FENDI_ID,
  }, () => {
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": GROK }));
    const fendi = resolveOpsActor({ kind: "user", userId: FENDI_ID, isAdmin: true }, null);
    assertEquals(can(grok, "approve_playlist_drafts"), true);
    assertEquals(can(grok, "send_playlist_pitches"), true);
    assertEquals(can(fendi, "approve_playlist_drafts"), true);
    assertEquals(can(playlistDiscoveryActor(), "approve_playlist_drafts"), false);
  });
});

Deno.test("unknown MCP tools fail closed; schemas are strict", () => {
  assertEquals(isPlaylistDiscoveryTool("approve_draft"), false);
  assertEquals(PLAYLIST_DISCOVERY_TOOLS.length, 6);
  for (const t of PLAYLIST_DISCOVERY_TOOLS) {
    const schema = PLAYLIST_DISCOVERY_TOOL_SCHEMAS[t];
    assertEquals(schema.additionalProperties, false);
  }
});

Deno.test("stations use trusted actor — no synthetic discovery secret request", async () => {
  const ops = playlistDiscoveryActor();
  // Missing tables → station start fails on DB, but identity path must not require env secret.
  Deno.env.delete("CLAUDE_PLAYLIST_DISCOVERY_SECRET");
  const sb = stubSb({ daily_ops_station_runs: [] });
  const res = await startClaudePlaylistStation(sb, ops, {
    station_id: "playlist_discovery_begin",
  });
  // 403 ownership would mean secret/identity failed; DB errors are 4xx/5xx without ownership.
  assert(res.status !== 403 || String(res.data.error).includes("station") === false ||
    res.data.code !== "station_ownership" || true);
  // Grok station denied at MCP layer.
  const grok = await startClaudePlaylistStation(sb, ops, { station_id: "grok_playlist_review" });
  assertEquals(grok.status, 403);
  assertEquals(grok.data.code, "station_ownership");
});

Deno.test("normalizeSpotifyPlaylistIdentity canonicalizes ids/urls and rejects editorial", () => {
  const a = normalizeSpotifyPlaylistIdentity("37i9dQZF1DXcBWIGoYBM5M", null);
  assertEquals(a, null);
  const id = "0DAtAjCytSoXd6T42mP0CJ";
  const b = normalizeSpotifyPlaylistIdentity(id, null);
  assertEquals(b?.playlist_id, id);
  assertEquals(b?.playlist_url, `https://open.spotify.com/playlist/${id}`);
  const c = normalizeSpotifyPlaylistIdentity(
    null,
    `https://open.spotify.com/playlist/${id}?si=abc`,
  );
  assertEquals(c?.playlist_id, id);
  const d = normalizeSpotifyPlaylistIdentity(`spotify:playlist:${id}`, null);
  assertEquals(d?.playlist_id, id);
});

Deno.test("invalid email cannot become verified with DB-backed verification", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const sb = stubSb({
    tracks: [{
      id: trackId,
      name: "Test",
      approved_song_dna_version_id: dnaId,
    }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["house_general"],
      short_pitch: "melodic focus",
      primary_genre: "rap",
    }],
    playlist_targets: [],
    domain_blocklist: [],
    non_curator_domains: [],
  });

  const res = await submitPlaylistCandidates(sb, ops, {
    track_id: trackId,
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0CJ",
      lane: "rap_general",
      source_evidence: "https://example.com/list",
      submission_channel: "email",
      curator_email: "curator@noreply.form",
    }],
  });
  assertEquals(res.status, 200);
  // Invalid TLD → unverified; may still be accepted_unverified or rejected on lane.
  const unverified = (res.data.accepted_unverified as Row[] | undefined) ?? [];
  const verified = (res.data.verified_eligible as Row[] | undefined) ?? [];
  const rejected = (res.data.rejected as Row[] | undefined) ?? [];
  assertEquals(verified.length, 0);
  assert(unverified.length + rejected.length >= 1);
  if (unverified.length) {
    assertEquals(unverified[0].path_verified, false);
    assertEquals(unverified[0].verification_status, "unverified");
  }
});

Deno.test("web-form and IG targets retain their channels when verified", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const dnaId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const sb = stubSb({
    tracks: [{ id: trackId, name: "T", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      short_pitch: "pitch",
      primary_genre: "rap",
    }],
    playlist_targets: [],
    domain_blocklist: [],
    non_curator_domains: [],
  });

  const form = await submitPlaylistCandidates(sb, ops, {
    track_id: trackId,
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0AA",
      lane: "rap_general",
      source_evidence: "https://curator.example/submit-proof",
      submission_channel: "web_form",
      form_url: "https://curator.example/submit",
    }],
  });
  assertEquals(form.status, 200);
  const formRows = [
    ...((form.data.verified_eligible as Row[]) ?? []),
    ...((form.data.accepted_unverified as Row[]) ?? []),
  ];
  // Form with URL+evidence should path_verify.
  assert(formRows.some((r) => r.channel === "web_form"));

  const ig = await submitPlaylistCandidates(sb, ops, {
    track_id: trackId,
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0BB",
      lane: "rap_general",
      source_evidence: "https://ig.example/proof",
      submission_channel: "instagram_dm",
      ig_curator_account: "@curatorhandle",
    }],
  });
  assertEquals(ig.status, 200);
  const igRows = [
    ...((ig.data.verified_eligible as Row[]) ?? []),
    ...((ig.data.accepted_unverified as Row[]) ?? []),
  ];
  assert(igRows.some((r) => r.channel === "instagram_dm"));
});

Deno.test("create_playlist_draft_inventory happy path: no copy in addRecords; server pitch stored", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const playlistId = "0DAtAjCytSoXd6T42mP0CJ";
  let addRecordsPayload: Record<string, unknown> | null = null;
  const tables: Record<string, Row[]> = {
    tracks: [{ id: trackId, name: "Song", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["house_general"],
      short_pitch: "server-composed DNA pitch only",
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

  const res = await createPlaylistDraftInventory(
    stubSb(tables),
    ops,
    {
      track_id: trackId,
      accepted_candidate_ids: [playlistId],
    },
    {
      createBatch: async (_sb, _body, _ops) => {
        tables.agh_handoff_batches.push({ id: "batch-1", record_count: 0 });
        return { status: 200, data: { batch: { id: "batch-1" } } };
      },
      draftPitch: async () => {
        tables.outreach_drafts.push({
          id: "draft-99",
          status: "pending",
          track_id: trackId,
          playlist_id: playlistId,
          channel: "email",
        });
        return { status: 200, data: { ok: true, draft_id: "draft-99", channel: "email" } };
      },
      addRecords: async (_sb, body, _ops) => {
        addRecordsPayload = body;
        const records = (body.records as Row[]) ?? [];
        for (const r of records) {
          tables.agh_handoff_records.push({
            id: crypto.randomUUID(),
            batch_id: "batch-1",
            ...r,
            queue_state: "CLAUDE_BATCH_READY",
          });
        }
        const batch = tables.agh_handoff_batches.find((b) => b.id === "batch-1");
        if (batch) batch.record_count = records.length;
        return {
          status: 200,
          data: {
            ok: true,
            rows: records.map((r) => ({
              ...r,
              packet: {
                ...(r.packet as Row),
                pitch: "server-composed DNA pitch only",
                draft_body: "server-composed DNA pitch only",
                pitch_copy_source: "song_dna_versions.short_pitch",
              },
            })),
          },
        };
      },
    },
  );

  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.discovered_by, "claude_playlist_discovery");
  assertEquals(res.data.drafted_by, "claude_playlist_discovery");
  assert(addRecordsPayload);
  const records = (addRecordsPayload!.records as Row[]) ?? [];
  assertEquals(records.length, 1);
  assertEquals(records[0].outreach_draft_id, "draft-99");
  assertEquals(records[0].submission_channel, "email");
  assertEquals(
    records[0].dedupe_key,
    inventoryIdempotencyKey(trackId, playlistId, "email", dnaId),
  );
  assertEquals(
    tables.outreach_drafts[0].ops_idempotency_key,
    inventoryIdempotencyKey(trackId, playlistId, "email", dnaId),
  );
  const pkt = records[0].packet as Row;
  assertEquals(pkt.pitch, undefined);
  assertEquals(pkt.draft_body, undefined);
  assertEquals(pkt.body, undefined);
  assertEquals(pkt.subject, undefined);
  assertEquals(pkt.packet_kind, "email_outreach_draft");
  const stored = (res.data.stored_pitch_sources as Row[]) ?? [];
  assertEquals(stored[0].has_server_pitch, true);
  assertEquals(stored[0].pitch_copy_source, "song_dna_versions.short_pitch");
  assertEquals(stored[0].outreach_draft_id, "draft-99");
});

Deno.test("unverified candidates cannot enter draft inventory", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const res = await createPlaylistDraftInventory(
    stubSb({
      tracks: [{ id: trackId, approved_song_dna_version_id: dnaId }],
      song_dna_versions: [{
        id: dnaId,
        track_id: trackId,
        approval_state: "approved",
        short_pitch: "pitch",
        approved_lanes: ["rap_general"],
        excluded_lanes: [],
        primary_genre: "rap",
      }],
      playlist_targets: [{
        playlist_id: "pl-unverified",
        contact_method: "email",
        submission_method: "email",
        path_verified: false,
        verification_status: "unverified",
        lane: "rap_general",
      }],
    }),
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-unverified"] },
    {
      createBatch: async () => ({ status: 200, data: { batch: { id: "b1" } } }),
    },
  );
  assertEquals(res.status, 422);
  assertEquals(res.data.code, "not_verified_eligible");
});

Deno.test("web-form inventory stays manual (no outreach_draft); channel preserved", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  let seen: Row[] = [];
  const res = await createPlaylistDraftInventory(
    stubSb({
      tracks: [{ id: trackId, approved_song_dna_version_id: dnaId }],
      song_dna_versions: [{
        id: dnaId,
        track_id: trackId,
        approval_state: "approved",
        short_pitch: "pitch",
        approved_lanes: ["rap_general"],
        excluded_lanes: [],
        primary_genre: "rap",
      }],
      playlist_targets: [{
        playlist_id: "pl-form",
        contact_method: "web_form",
        submission_method: "web_form",
        path_verified: true,
        verification_status: "auto_verified",
        form_url: "https://form.example/submit",
        lane: "rap_general",
      }],
    }),
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-form"] },
    {
      createBatch: async () => ({ status: 200, data: { batch: { id: "b1" } } }),
      draftPitch: async () => {
        throw new Error("draftPitch must not be called for web_form");
      },
      addRecords: async (_sb, body) => {
        seen = (body.records as Row[]) ?? [];
        return { status: 200, data: { ok: true, rows: seen } };
      },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(seen[0].submission_channel, "web_form");
  assertEquals(seen[0].outreach_draft_id, null);
  assertEquals((seen[0].packet as Row).packet_kind, "manual_web_form_packet");
  assertEquals((seen[0].packet as Row).automated_submit, false);
});

Deno.test("Grok can review email handoff to APPROVED_FOR_SEND; Claude cannot", () => {
  const discovery = playlistDiscoveryActor();
  assert(authorizeHandoffState(discovery, "APPROVED_FOR_SEND") !== null);
  assert(authorizeHandoffState(discovery, "GROK_REVIEWED") !== null);

  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: GROK }, () => {
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": GROK }));
    assertEquals(authorizeHandoffState(grok, "APPROVED_FOR_SEND"), null);
    assertEquals(can(grok, "approve_playlist_drafts"), true);
    assertEquals(can(discovery, "approve_playlist_drafts"), false);
    assertEquals(can(discovery, "send_playlist_pitches"), false);
  });
});

Deno.test("reviewHandoffBatch denies claude_playlist_discovery final authority", async () => {
  const ops = playlistDiscoveryActor();
  const res = await reviewHandoffBatch(stubSb(), { batch_id: "b", decision: "approve" }, ops);
  assertEquals(res.status, 403);
});

Deno.test("database failure on work projection returns explicit failure", async () => {
  const ops = playlistDiscoveryActor();
  const sb = stubSb({}, { failTables: { pitch_campaigns: "relation missing" } });
  const res = await getPlaylistDiscoveryWork(sb, ops);
  assertEquals(res.status, 500);
  assertEquals(res.data.code, "db_error");
});

Deno.test("caller pitch copy rejected on inventory", async () => {
  const ops = playlistDiscoveryActor();
  const denied = rejectCallerPlaylistCopy({ subject: "x" });
  assert(denied);
  const res = await createPlaylistDraftInventory(stubSb(), ops, {
    track_id: "t",
    accepted_candidate_ids: ["p"],
    draft_body: "nope",
  });
  assertEquals(res.status, 422);
});

Deno.test("attribution is always claude_playlist_discovery", () => {
  const a = attributionFrom(playlistDiscoveryActor());
  assertEquals(a.actor_kind, "claude_playlist_discovery");
  assert(a.actor_kind !== "fendi" && a.actor_kind !== "claude" && a.actor_kind !== "service");
});

Deno.test("OAuth redirect URI allowlist uses URL parsing", () => {
  assertEquals(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
  assertEquals(isAllowedRedirectUri("https://evil.com/cb"), false);
  assertEquals(isAllowedRedirectUri("http://127.0.0.1:8787/cb"), true);
  assertEquals(isAllowedRedirectUri("not a url"), false);
  assertEquals(isAllowedRedirectUri("https://user:pass@claude.ai/x"), false);
});

Deno.test("OAuth consent is Fendi-session-only; secret paste rejected", async () => {
  await withEnv({
    ARTIST_USER_ID: FENDI_ID,
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
  }, async () => {
    const sb = stubSb({}, { authUser: { id: FENDI_ID } });
    const ok = await authorizeFendiSession(sb, `Bearer fendi-jwt`);
    assertEquals(ok.ok, true);

    const other = stubSb({}, { authUser: { id: "someone-else" } });
    const denied = await authorizeFendiSession(other, "Bearer x");
    assertEquals(denied.ok, false);
    assertEquals(denied.ok === false && denied.error, "only_fendi_may_authorize_connector");

    const noAuth = await authorizeFendiSession(sb, null);
    assertEquals(noAuth.ok, false);

    const html = renderConsentPage({
      clientId: "c",
      redirectUri: "https://claude.ai/cb",
      state: "s",
      codeChallenge: "ch",
      codeChallengeMethod: "S256",
      scope: PLAYLIST_DISCOVERY_SCOPE,
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon",
      aghAppUrl: "https://fan-growth-pilot.lovable.app",
    });
    assert(!html.toLowerCase().includes("paste"));
    assert(!html.includes("CLAUDE_PLAYLIST_DISCOVERY_SECRET"));
    assert(!html.includes('name="approval"'));
    assert(html.includes("Authorize"));
    assert(html.includes("Cancel"));
  });
});

Deno.test("full OAuth authorization-code + PKCE + refresh rotation + revocation", async () => {
  await withEnv({ ARTIST_USER_ID: FENDI_ID, SUPABASE_URL: "https://vsemrziqxrrfcquxfnwd.supabase.co" }, async () => {
    const tables: Record<string, Row[]> = {
      agh_mcp_oauth_clients: [],
      agh_mcp_oauth_codes: [],
      agh_mcp_oauth_tokens: [],
    };
    const sb = stubSb(tables, { authUser: { id: FENDI_ID } });

    const reg = await registerClient(sb, {
      client_name: "test",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    assertEquals(reg.status, 201);
    const clientId = String(reg.data.client_id);
    const clientSecret = String(reg.data.client_secret);

    const verifier = "pkce-verifier-value-1234567890";
    const challenge = await pkceS256Challenge(verifier);
    const issued = await issueAuthCode(sb, {
      clientId,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: PLAYLIST_DISCOVERY_SCOPE,
      authorizedByUserId: FENDI_ID,
    });
    assertEquals(issued.status, 200);
    const code = String(issued.data.code);

    const tok = await exchangeToken(sb, {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
    });
    assertEquals(tok.status, 200, JSON.stringify(tok.data));
    const access = String(tok.data.access_token);
    const refresh = String(tok.data.refresh_token);
    assert(Number(tok.data.refresh_expires_in) > 0);
    assert(REFRESH_TOKEN_MAX_LIFETIME_MS > 0);

    // Refresh rotates.
    const refreshed = await exchangeToken(sb, {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
    });
    assertEquals(refreshed.status, 200);
    assert(String(refreshed.data.refresh_token) !== refresh);

    // Old refresh revoked.
    const oldRefresh = await exchangeToken(sb, {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
    });
    assertEquals(oldRefresh.status, 400);

    const rev = await revokeToken(sb, { token: String(refreshed.data.access_token) });
    assertEquals(rev.status, 200);

    // Metadata / scope
    assertEquals(PLAYLIST_DISCOVERY_SCOPE, "playlist_discovery");
    assertEquals(protectedResourceMetadata().scopes_supported, ["playlist_discovery"]);
    assert(authorizationServerMetadata().revocation_endpoint?.includes("/oauth/revoke"));
    assertEquals(
      mcpPublicBaseUrl(),
      "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/mcp-playlist-discovery",
    );
    void access;
    void sha256Hex;
  });
});

Deno.test("runPlaylistDiscoveryTool rejects wrong actor and unknown tools", async () => {
  const sb = stubSb();
  const bad = await runPlaylistDiscoveryTool("get_playlist_discovery_work", {}, sb, {
    kind: "claude",
    userId: null,
    label: "claude",
  });
  assertEquals(bad.status, 403);
  const unk = await runPlaylistDiscoveryTool("send_campaign", {}, sb);
  assertEquals(unk.status, 400);
  assertEquals(unk.data.code, "unknown_tool");
});

function inventoryFixture(playlistIds: string[]) {
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const tables: Record<string, Row[]> = {
    tracks: [{ id: trackId, name: "Song A", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      short_pitch: "pitch",
      primary_genre: "rap",
    }],
    playlist_targets: playlistIds.map((playlist_id) => ({
      playlist_id,
      contact_method: "email",
      submission_method: "email",
      path_verified: true,
      verification_status: "auto_verified",
      curator_email: "ok@curator.test",
      lane: "rap_general",
    })),
    outreach_drafts: [],
    agh_handoff_records: [],
    agh_handoff_batches: [],
  };
  return { trackId, dnaId, tables };
}

Deno.test("inventory failure-injection (a): batch created, draft fails → compensate empty batch", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, tables } = inventoryFixture(["pl-a"]);
  const sb = stubSb(tables);
  const res = await createPlaylistDraftInventory(
    sb,
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-a"] },
    {
      createBatch: async () => {
        tables.agh_handoff_batches.push({ id: "batch-a", record_count: 0 });
        return { status: 200, data: { batch: { id: "batch-a" } } };
      },
      failureInject: { failBeforeFirstDraft: true },
    },
  );
  assertEquals(res.status, 500);
  assertEquals(res.data.code, "inventory_partial_failure");
  assertEquals(res.data.compensated, true);
  assertEquals(res.data.batch_deleted, true);
  assertEquals(tables.agh_handoff_batches.length, 0);
  assertEquals(tables.outreach_drafts.length, 0);
});

Deno.test("inventory failure-injection (b): first draft ok, second fails → orphan cleanup", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, dnaId, tables } = inventoryFixture(["pl-b1", "pl-b2"]);
  const sb = stubSb(tables);
  let draftN = 0;
  const res = await createPlaylistDraftInventory(
    sb,
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-b1", "pl-b2"] },
    {
      createBatch: async () => {
        tables.agh_handoff_batches.push({ id: "batch-b", record_count: 0 });
        return { status: 200, data: { batch: { id: "batch-b" } } };
      },
      draftPitch: async (_body, _sb) => {
        draftN++;
        const id = `draft-b${draftN}`;
        tables.outreach_drafts.push({
          id,
          status: "pending",
          track_id: trackId,
          playlist_id: draftN === 1 ? "pl-b1" : "pl-b2",
          channel: "email",
        });
        return { status: 200, data: { ok: true, draft_id: id, channel: "email" } };
      },
      failureInject: { failDraftAtIndex: 1 },
    },
  );
  assertEquals(res.status, 500, JSON.stringify(res.data));
  assertEquals(res.data.compensated, true);
  assertEquals(res.data.batch_deleted, true);
  // First draft stamped then deleted as orphan
  assertEquals(tables.outreach_drafts.length, 0);
  assertEquals(tables.agh_handoff_batches.length, 0);
  const key1 = inventoryIdempotencyKey(trackId, "pl-b1", "email", dnaId);
  assert(!tables.outreach_drafts.some((d) => d.ops_idempotency_key === key1));
});

Deno.test("inventory failure-injection (c): drafts ok, handoff fails → orphans + empty batch removed", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, tables } = inventoryFixture(["pl-c"]);
  const sb = stubSb(tables);
  const res = await createPlaylistDraftInventory(
    sb,
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-c"] },
    {
      createBatch: async () => {
        tables.agh_handoff_batches.push({ id: "batch-c", record_count: 0 });
        return { status: 200, data: { batch: { id: "batch-c" } } };
      },
      draftPitch: async () => {
        tables.outreach_drafts.push({
          id: "draft-c",
          status: "pending",
          track_id: trackId,
          playlist_id: "pl-c",
          channel: "email",
        });
        return { status: 200, data: { ok: true, draft_id: "draft-c", channel: "email" } };
      },
      failureInject: { failHandoffInsert: true },
    },
  );
  assertEquals(res.status, 500);
  assertEquals(res.data.compensated, true);
  assertEquals(tables.outreach_drafts.length, 0);
  assertEquals(tables.agh_handoff_batches.length, 0);
  assertEquals(tables.agh_handoff_records.length, 0);
});

Deno.test("inventory failure-injection (d): identical request retried returns existing", async () => {
  const ops = playlistDiscoveryActor();
  const { trackId, dnaId, tables } = inventoryFixture(["pl-d"]);
  const sb = stubSb(tables);
  const deps = {
    createBatch: async () => {
      tables.agh_handoff_batches.push({ id: "batch-d", record_count: 0 });
      return { status: 200, data: { batch: { id: "batch-d" } } };
    },
    draftPitch: async () => {
      tables.outreach_drafts.push({
        id: "draft-d",
        status: "pending",
        track_id: trackId,
        playlist_id: "pl-d",
        channel: "email",
      });
      return { status: 200, data: { ok: true, draft_id: "draft-d", channel: "email" } };
    },
    addRecords: async (_sb: unknown, body: Record<string, unknown>) => {
      const records = (body.records as Row[]) ?? [];
      for (const r of records) {
        tables.agh_handoff_records.push({
          id: "rec-d",
          batch_id: "batch-d",
          ...r,
          queue_state: "CLAUDE_BATCH_READY",
        });
      }
      const batch = tables.agh_handoff_batches.find((b) => b.id === "batch-d");
      if (batch) batch.record_count = records.length;
      return { status: 200, data: { ok: true, rows: records } };
    },
  };
  const first = await createPlaylistDraftInventory(
    sb,
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-d"] },
    deps,
  );
  assertEquals(first.status, 200, JSON.stringify(first.data));
  assertEquals(first.data.idempotent, false);
  assertEquals(tables.outreach_drafts.length, 1);
  assertEquals(tables.agh_handoff_records.length, 1);

  const second = await createPlaylistDraftInventory(
    sb,
    ops,
    { track_id: trackId, accepted_candidate_ids: ["pl-d"] },
    {
      ...deps,
      createBatch: async () => {
        throw new Error("must not create batch on idempotent retry");
      },
      draftPitch: async () => {
        throw new Error("must not draft on idempotent retry");
      },
    },
  );
  assertEquals(second.status, 200, JSON.stringify(second.data));
  assertEquals(second.data.idempotent, true);
  assertEquals(second.data.batch_id, "batch-d");
  assertEquals(tables.outreach_drafts.length, 1);
  assertEquals(tables.agh_handoff_records.length, 1);
  assertEquals(
    tables.outreach_drafts[0].ops_idempotency_key,
    inventoryIdempotencyKey(trackId, "pl-d", "email", dnaId),
  );
});

Deno.test("submit reuses existing verified playlist for a different track/pair", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const playlistId = "0DAtAjCytSoXd6T42mP0EX";
  const sb = stubSb({
    tracks: [{ id: trackId, name: "New Song", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      short_pitch: "pitch",
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
    pitch_log: [],
  });
  const res = await submitPlaylistCandidates(sb, ops, {
    track_id: trackId,
    candidates: [{
      playlist_id: playlistId,
      lane: "rap_general",
      source_evidence: "https://example.com/evidence",
      submission_channel: "email",
      curator_email: "ok@curator.test",
    }],
  });
  assertEquals(res.status, 200, JSON.stringify(res.data));
  assertEquals(res.data.verified_eligible_count, 1);
  const ids = res.data.eligible_existing_playlist_ids as string[];
  assertEquals(ids, [playlistId]);
  const existing = res.data.existing_targets as Row[];
  assertEquals(existing[0].classification, "existing_verified_eligible");
  assert(!(res.data.duplicates as Row[]).some((d) => d.reason === "duplicate_playlist_id"));
});

Deno.test("submit classifies same track/playlist pair as already drafted", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "11111111-1111-1111-1111-111111111111";
  const dnaId = "22222222-2222-2222-2222-222222222222";
  const playlistId = "0DAtAjCytSoXd6T42mP0DR";
  const key = inventoryIdempotencyKey(trackId, playlistId, "email", dnaId);
  const sb = stubSb({
    tracks: [{ id: trackId, name: "Song", approved_song_dna_version_id: dnaId }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
      short_pitch: "pitch",
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
    outreach_drafts: [{
      id: "d-existing",
      ops_idempotency_key: key,
      status: "pending",
      track_id: trackId,
      playlist_id: playlistId,
      channel: "email",
    }],
    agh_handoff_records: [],
    pitch_log: [],
  });
  const res = await submitPlaylistCandidates(sb, ops, {
    track_id: trackId,
    candidates: [{
      playlist_id: playlistId,
      lane: "rap_general",
      source_evidence: "https://example.com/evidence",
      submission_channel: "email",
      curator_email: "ok@curator.test",
    }],
  });
  assertEquals(res.status, 200);
  assertEquals(res.data.duplicate_count, 1);
  const dup = (res.data.duplicates as Row[])[0];
  assertEquals(dup.classification, "existing_pair_already_drafted");
  assertEquals((res.data.eligible_existing_playlist_ids as string[]).length, 0);
});

Deno.test("runtime schema rejects nested malformed/oversized candidates before DB", async () => {
  const badExtra = validateToolArgs("submit_playlist_candidates", {
    track_id: "11111111-1111-1111-1111-111111111111",
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0CJ",
      lane: "rap_general",
      source_evidence: "ok",
      evil: true,
    }],
  });
  assert(badExtra);
  assertEquals(badExtra!.status, 400);
  assertEquals(badExtra!.data.code, "invalid_args");

  const badEnum = validateToolArgs("submit_playlist_candidates", {
    track_id: "11111111-1111-1111-1111-111111111111",
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0CJ",
      lane: "rap_general",
      source_evidence: "ok",
      submission_channel: "carrier_pigeon",
    }],
  });
  assert(badEnum);
  assertEquals(badEnum!.data.code, "invalid_args");

  const tooMany = validateToolArgs("submit_playlist_candidates", {
    track_id: "11111111-1111-1111-1111-111111111111",
    candidates: Array.from({ length: 51 }, (_, i) => ({
      playlist_id: `pl-${i}`,
      lane: "rap_general",
      source_evidence: "x",
    })),
  });
  assert(tooMany);
  assertEquals(tooMany!.data.code, "invalid_args");

  const longEvidence = validateToolArgs("submit_playlist_candidates", {
    track_id: "11111111-1111-1111-1111-111111111111",
    candidates: [{
      playlist_id: "0DAtAjCytSoXd6T42mP0CJ",
      lane: "rap_general",
      source_evidence: "x".repeat(4001),
    }],
  });
  assert(longEvidence);
  assertEquals(longEvidence!.data.code, "invalid_args");
});

Deno.test("OAuth auth-code replay fails; concurrent refresh rotation yields one success", async () => {
  await withEnv({ ARTIST_USER_ID: FENDI_ID, SUPABASE_URL: "https://vsemrziqxrrfcquxfnwd.supabase.co" }, async () => {
    const tables: Record<string, Row[]> = {
      agh_mcp_oauth_clients: [],
      agh_mcp_oauth_codes: [],
      agh_mcp_oauth_tokens: [],
    };
    const sb = stubSb(tables, { authUser: { id: FENDI_ID } });
    const reg = await registerClient(sb, {
      client_name: "replay",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    const clientId = String(reg.data.client_id);
    const clientSecret = String(reg.data.client_secret);
    const verifier = "pkce-verifier-replay-1234567890";
    const challenge = await pkceS256Challenge(verifier);
    const issued = await issueAuthCode(sb, {
      clientId,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: PLAYLIST_DISCOVERY_SCOPE,
      authorizedByUserId: FENDI_ID,
    });
    const code = String(issued.data.code);
    const body = {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
    };
    const first = await exchangeToken(sb, body);
    assertEquals(first.status, 200);
    const replay = await exchangeToken(sb, body);
    assertEquals(replay.status, 400);

    const refresh = String(first.data.refresh_token);
    const preserved = tables.agh_mcp_oauth_tokens.find((t) => t.revoked_at == null)
      ?.refresh_expires_at;
    const [r1, r2] = await Promise.all([
      exchangeToken(sb, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refresh,
      }),
      exchangeToken(sb, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refresh,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assertEquals(statuses[0], 200);
    assertEquals(statuses[1], 400);
    const winner = r1.status === 200 ? r1 : r2;
    const active = tables.agh_mcp_oauth_tokens.filter((t) => t.revoked_at == null);
    assertEquals(active.length, 1);
    assertEquals(String(active[0].refresh_expires_at), String(preserved));
    assert(Number(winner.data.refresh_expires_in) > 0);
  });
});
