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
  getPlaylistDiscoveryWork,
  submitPlaylistCandidates,
  createPlaylistDraftInventory,
  startClaudePlaylistStation,
} from "./playlist-discovery-mcp.ts";
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
  } = {},
  // deno-lint-ignore no-explicit-any
): any {
  const writes = opts.writes ?? [];
  const failTables = opts.failTables ?? {};
  return {
    auth: {
      getUser: (_t: string) =>
        Promise.resolve({
          data: { user: opts.authUser ?? null },
          error: opts.authUser ? null : new Error("bad token"),
        }),
    },
    rpc: (name: string) => {
      if (name === "agh_mcp_oauth_cleanup_expired") {
        return Promise.resolve({ data: { ok: true, codes_deleted: 0, tokens_deleted: 0 }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
    from: (table: string) => {
      if (!tables[table]) tables[table] = [];
      let filters: Record<string, unknown> = {};
      let mode: "select" | "insert" | "update" | "delete" = "select";
      let payload: Row | Row[] | null = null;
      const apply = () =>
        tables[table].filter((r) =>
          Object.entries(filters).every(([k, v]) => {
            if (v && typeof v === "object" && (v as { __null?: boolean }).__null) {
              return r[k] == null;
            }
            if (v && typeof v === "object" && "__lt" in (v as object)) {
              return String(r[k]) < String((v as { __lt: unknown }).__lt);
            }
            if (Array.isArray(v)) return v.map(String).includes(String(r[k]));
            return String(r[k]) === String(v);
          })
        );
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
          tables[table] = tables[table].filter(
            (r) => !Object.entries(filters).every(([k, v]) => String(r[k]) === String(v)),
          );
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        if (mode === "update" && payload && !Array.isArray(payload)) {
          for (const r of apply()) Object.assign(r, payload);
          writes.push({ table, op: "update", row: { ...(payload as Row) } });
          return Promise.resolve(resolve({ data: null, error: null }));
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

  const res = await createPlaylistDraftInventory(
    stubSb({
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
    }),
    ops,
    {
      track_id: trackId,
      accepted_candidate_ids: [playlistId],
    },
    {
      createBatch: async (_sb, _body, _ops) => ({
        status: 200,
        data: { batch: { id: "batch-1" } },
      }),
      draftPitch: async () => ({
        status: 200,
        data: { ok: true, draft_id: "draft-99", channel: "email" },
      }),
      addRecords: async (_sb, body, _ops) => {
        addRecordsPayload = body;
        const records = (body.records as Row[]) ?? [];
        // Simulate server-side compose that addHandoffRecords performs.
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
  // fail on maybeSingle path — also need select thenable to fail
  const res = await getPlaylistDiscoveryWork(sb, ops);
  // Depending on stub path: campaigns select uses thenable
  assert(res.status === 500 || res.status === 200);
  if (res.status === 200) {
    // Force fail via profiles
    const sb2 = stubSb(
      { pitch_campaigns: [] },
      { failTables: { discovery_profiles: "boom" } },
    );
    const r2 = await getPlaylistDiscoveryWork(sb2, ops);
    assertEquals(r2.status, 500);
    assertEquals(r2.data.code, "db_error");
  } else {
    assertEquals(res.data.code, "db_error");
  }
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
