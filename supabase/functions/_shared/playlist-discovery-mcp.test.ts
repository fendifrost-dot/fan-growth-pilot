/**
 * Remote MCP playlist-discovery connector — actor matrix, tool fail-closed,
 * attribution, and denial of DNA/approve/send/fan/radio/licensing surfaces.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  resolveOpsActor,
  attributionFrom,
} from "./ops-actors.ts";
import { authorizeAction } from "./outreach-auth.ts";
import { authorizeStationOperator } from "./chicago-time.ts";
import { authorizeHandoffState } from "./handoff-queues.ts";
import { rejectCallerPlaylistCopy } from "./pitch-descriptor-guard.ts";
import {
  PLAYLIST_DISCOVERY_TOOLS,
  isPlaylistDiscoveryTool,
  playlistDiscoveryActor,
  runPlaylistDiscoveryTool,
  getPlaylistDiscoveryWork,
  submitPlaylistCandidates,
  createPlaylistDraftInventory,
} from "./playlist-discovery-mcp.ts";
import {
  mcpPublicBaseUrl,
  PLAYLIST_DISCOVERY_SCOPE,
  protectedResourceMetadata,
  authorizationServerMetadata,
  sha256Hex,
  pkceS256Challenge,
} from "./mcp-oauth.ts";

const DISCOVERY = "pd-secret-narrow-only";
const CLAUDE = "claude-agent-secret-broad";
const GROK = "grok-control-secret";
const HUB = "hub-service-key";
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

// deno-lint-ignore no-explicit-any
function stubSb(tables: Record<string, unknown[]> = {}): any {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: new Error("no jwt") }),
    },
    from: (table: string) => {
      const rows = [...(tables[table] ?? [])] as Record<string, unknown>[];
      const state: { filters: Record<string, unknown>; op: string } = {
        filters: {},
        op: "select",
      };
      const chain: Record<string, unknown> = {};
      const applyFilter = () =>
        rows.filter((r) =>
          Object.entries(state.filters).every(([k, v]) => {
            if (Array.isArray(v)) return v.includes(r[k]);
            return r[k] === v;
          })
        );
      chain.select = () => chain;
      chain.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        state.op = "insert";
        const list = Array.isArray(row) ? row : [row];
        for (const r of list) rows.push({ ...r });
        tables[table] = rows;
        return chain;
      };
      chain.delete = () => {
        state.op = "delete";
        return chain;
      };
      chain.update = () => chain;
      chain.eq = (col: string, val: unknown) => {
        state.filters[col] = val;
        return chain;
      };
      chain.in = (col: string, vals: unknown[]) => {
        state.filters[col] = vals;
        return chain;
      };
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () => {
        const hit = applyFilter()[0] ?? null;
        return Promise.resolve({ data: hit, error: null });
      };
      chain.single = () => {
        const hit = applyFilter()[0];
        return Promise.resolve({
          data: hit ?? null,
          error: hit ? null : { message: "not found" },
        });
      };
      // Thenable for await sb.from().select()...
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (state.op === "delete") {
          const keep = rows.filter((r) =>
            !Object.entries(state.filters).every(([k, v]) => r[k] === v)
          );
          tables[table] = keep;
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        if (state.op === "insert") {
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        return Promise.resolve(resolve({ data: applyFilter(), error: null }));
      };
      return chain;
    },
  };
}

Deno.test("connector actor resolves from CLAUDE_PLAYLIST_DISCOVERY_SECRET without Fendi JWT", () => {
  withEnv({
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
    CLAUDE_AGENT_SECRET: CLAUDE,
    ARTIST_USER_ID: FENDI_ID,
  }, () => {
    const actor = resolveOpsActor(
      null,
      req({ "x-claude-playlist-discovery-secret": DISCOVERY }),
    );
    assertEquals(actor.kind, "claude_playlist_discovery");
    assertEquals(actor.userId, null);
    // No Fendi JWT required.
    assertEquals(can(actor, "read_playlist_discovery_work"), true);
    assertEquals(can(actor, "submit_playlist_candidates"), true);
    assertEquals(can(actor, "generate_playlist_drafts"), true);
    assertEquals(can(actor, "create_handoff_batch"), true);
    assertEquals(can(actor, "run_daily_station"), true);
  });
});

Deno.test("broad Claude secret does not elevate to playlist-discovery actor", () => {
  withEnv({
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
    CLAUDE_AGENT_SECRET: CLAUDE,
  }, () => {
    const broad = resolveOpsActor(null, req({ "x-claude-agent-secret": CLAUDE }));
    assertEquals(broad.kind, "claude");
    assertEquals(can(broad, "draft_song_dna"), true);
    assertEquals(can(broad, "submit_playlist_candidates"), false);

    const discovery = resolveOpsActor(
      null,
      req({ "x-claude-playlist-discovery-secret": DISCOVERY }),
    );
    assertEquals(discovery.kind, "claude_playlist_discovery");
    assertEquals(can(discovery, "draft_song_dna"), false);
  });
});

Deno.test("playlist-discovery cannot mutate DNA, approve, send, reply, or place", () => {
  const ops = playlistDiscoveryActor();
  for (const cap of [
    "draft_song_dna",
    "submit_song_dna_for_review",
    "approve_song_dna",
    "reject_song_dna",
    "approve_playlist_drafts",
    "reject_playlist_drafts",
    "send_playlist_pitches",
    "monitor_inbox",
    "classify_replies",
    "respond_to_curators",
    "run_placement_discovery",
    "record_placement_evidence",
    "manage_fan_engagement",
    "manage_radio",
    "manage_sync_registers",
    "manage_campaigns",
    "manage_catalog",
    "approve_sample_declaration",
    "approve_sync_eligibility",
    "alter_approved_song_dna",
    "read_playlist_ops",
  ] as const) {
    assertEquals(can(ops, cap), false, `must deny ${cap}`);
  }
});

Deno.test("Grok remains sole operational approve/send actor besides Fendi", () => {
  withEnv({
    GROK_PLAYLIST_CONTROL_SECRET: GROK,
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
    CLAUDE_AGENT_SECRET: CLAUDE,
    ARTIST_USER_ID: FENDI_ID,
  }, () => {
    const grok = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": GROK }));
    const discovery = resolveOpsActor(
      null,
      req({ "x-claude-playlist-discovery-secret": DISCOVERY }),
    );
    const claude = resolveOpsActor(null, req({ "x-claude-agent-secret": CLAUDE }));
    const fendi = resolveOpsActor({ kind: "user", userId: FENDI_ID, isAdmin: true }, null);

    assertEquals(can(grok, "approve_playlist_drafts"), true);
    assertEquals(can(grok, "send_playlist_pitches"), true);
    assertEquals(can(fendi, "approve_playlist_drafts"), true);
    assertEquals(can(fendi, "send_playlist_pitches"), true);
    assertEquals(can(discovery, "approve_playlist_drafts"), false);
    assertEquals(can(discovery, "send_playlist_pitches"), false);
    assertEquals(can(claude, "approve_playlist_drafts"), false);
    assertEquals(can(claude, "send_playlist_pitches"), false);
  });
});

Deno.test("fan / radio / licensing / unrestricted draft reads denied via authorizeAction", async () => {
  await withEnv({
    CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY,
    CLAUDE_AGENT_SECRET: CLAUDE,
  }, async () => {
    const headers = { "x-claude-playlist-discovery-secret": DISCOVERY };
    const sb = stubSb();
    for (const action of [
      "get_leads",
      "list_fan_roster",
      "get_fan_stats",
      "get_radio_targets",
      "get_radio_pitch_log",
      "list_music_supervisors",
      "list_licensing_pitches",
      "list_drafts",
      "list_pitches",
      "get_pitch_log",
      "list_song_dna",
      "approve_draft",
      "send_campaign",
      "approve_song_dna",
      "mark_pitch_response",
      "discover_spotify_placements",
    ]) {
      const d = await authorizeAction(action, req(headers), sb);
      assertEquals(d.ok, false, `discovery must be denied ${action}`);
    }

    // Remaining authenticated-read actions also fail closed for machines.
    for (const action of ["list_tracks", "list_unverified_targets", "get_outreach_stats"]) {
      const d = await authorizeAction(action, req(headers), sb);
      assertEquals(d.ok, false, `authenticated-read must fail closed for ${action}`);
    }
  });
});

Deno.test("Claude playlist-discovery may start/complete Claude stations only", () => {
  assertEquals(
    authorizeStationOperator("playlist_discovery_begin", "claude_playlist_discovery", "start"),
    null,
  );
  assertEquals(
    authorizeStationOperator("playlist_tranche_final", "claude_playlist_discovery", "complete"),
    null,
  );
  const grokStart = authorizeStationOperator(
    "grok_playlist_review",
    "claude_playlist_discovery",
    "start",
  );
  assert(grokStart !== null);
  assert(String(grokStart).includes("Grok") || String(grokStart).includes("cannot"));
  const grokSend = authorizeStationOperator(
    "grok_playlist_send",
    "claude_playlist_discovery",
    "complete",
  );
  assert(grokSend !== null);
});

Deno.test("playlist-discovery cannot advance handoff to approval/send states", () => {
  const ops = playlistDiscoveryActor();
  assertEquals(authorizeHandoffState(ops, "CLAUDE_BATCH_READY"), null);
  assertEquals(authorizeHandoffState(ops, "CLAUDE_PLAYLIST_COMPLETE"), null);
  assertEquals(authorizeHandoffState(ops, "AWAITING_GROK_REVIEW"), null);
  assert(authorizeHandoffState(ops, "APPROVED_FOR_SEND") !== null);
  assert(authorizeHandoffState(ops, "GROK_REVIEWED") !== null);
  assert(authorizeHandoffState(ops, "REJECTED_BY_GROK") !== null);
});

Deno.test("unknown MCP tool names fail closed — never forward arbitrary actions", async () => {
  const sb = stubSb();
  const unknown = await runPlaylistDiscoveryTool("approve_draft", {}, sb);
  assertEquals(unknown.status, 400);
  assertEquals(unknown.data.code, "unknown_tool");

  const spoof = await runPlaylistDiscoveryTool("get_leads", {}, sb);
  assertEquals(spoof.status, 400);
  assertEquals(spoof.data.code, "unknown_tool");

  assertEquals(isPlaylistDiscoveryTool("get_playlist_discovery_work"), true);
  assertEquals(isPlaylistDiscoveryTool("send_campaign"), false);
  assertEquals(PLAYLIST_DISCOVERY_TOOLS.length, 6);
});

Deno.test("wrong actor kind cannot run playlist discovery tools", async () => {
  const sb = stubSb();
  const res = await runPlaylistDiscoveryTool("get_playlist_discovery_work", {}, sb, {
    kind: "claude",
    userId: null,
    label: "claude",
  });
  assertEquals(res.status, 403);
});

Deno.test("caller-supplied pitch copy is rejected", () => {
  for (const key of ["subject", "body", "draft_body"]) {
    const denied = rejectCallerPlaylistCopy({ [key]: "please place this track" });
    assert(denied !== null);
    assertEquals(denied!.status, 422);
  }
});

Deno.test("create_playlist_draft_inventory rejects caller copy and override", async () => {
  const ops = playlistDiscoveryActor();
  const sb = stubSb();
  const copy = await createPlaylistDraftInventory(sb, ops, {
    track_id: "t1",
    accepted_candidate_ids: ["pl1"],
    subject: "hi",
  });
  assertEquals(copy.status, 422);

  const override = await createPlaylistDraftInventory(sb, ops, {
    track_id: "t1",
    accepted_candidate_ids: ["pl1"],
    override_category_check: true,
  });
  assertEquals(override.status, 403);
  assertEquals(override.data.code, "override_forbidden");
});

Deno.test("submit rejects stale DNA and missing lane; stamps attribution", async () => {
  await withEnv({ CLAUDE_PLAYLIST_DISCOVERY_SECRET: DISCOVERY }, async () => {
    const ops = playlistDiscoveryActor();
    const attr = attributionFrom(ops);
    assertEquals(attr.actor_kind, "claude_playlist_discovery");

    const trackId = "11111111-1111-1111-1111-111111111111";
    const dnaId = "22222222-2222-2222-2222-222222222222";
    const sb = stubSb({
      tracks: [{
        id: trackId,
        name: "Test Track",
        approved_song_dna_version_id: dnaId,
      }],
      song_dna_versions: [{
        id: dnaId,
        track_id: trackId,
        approval_state: "approved",
        approved_lanes: ["rap_general"],
        excluded_lanes: ["house_general"],
        short_pitch: "melodic rap meditation",
        primary_genre: "rap",
      }],
      playlist_targets: [],
      pitch_campaigns: [{ track_id: trackId, status: "active" }],
      discovery_profiles: [],
      agh_handoff_batches: [],
    });

    // Stale / wrong DNA pointer from caller.
    const stale = await submitPlaylistCandidates(sb, ops, {
      track_id: trackId,
      song_dna_version_id: "99999999-9999-9999-9999-999999999999",
      candidates: [{
        playlist_id: "pl-stale",
        lane: "rap_general",
        source_evidence: "https://example.com/evidence",
        curator_email: "curator@example.com",
      }],
    });
    assertEquals(stale.status, 422);

    // Missing lane fails closed.
    const noLane = await submitPlaylistCandidates(sb, ops, {
      track_id: trackId,
      candidates: [{
        playlist_id: "pl-nolane",
        source_evidence: "https://example.com/evidence",
        curator_email: "curator@example.com",
      }],
    });
    assertEquals(noLane.status, 200);
    assertEquals(noLane.data.rejected_count, 1);
    assertEquals(
      (noLane.data.rejected as { reason: string }[])[0].reason,
      "unknown_lane_fail_closed",
    );

    // Happy path accepts with authenticated attribution (lane check may reject
    // depending on outreach-decision stub depth — at least discovered_by stamp).
    const ok = await submitPlaylistCandidates(sb, ops, {
      track_id: trackId,
      candidates: [{
        playlist_id: "pl-ok",
        lane: "rap_general",
        source_evidence: "https://example.com/evidence",
        curator_email: "curator@example.com",
        verified: true,
        compatible: true,
        discovered_by: "fendi",
      }],
    });
    assertEquals(ok.status, 200);
    assertEquals(ok.data.discovered_by, "claude_playlist_discovery");
  });
});

Deno.test("get_playlist_discovery_work returns minimal projection without ISRC", async () => {
  const ops = playlistDiscoveryActor();
  const trackId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const dnaId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const sb = stubSb({
    pitch_campaigns: [{ track_id: trackId, status: "active" }],
    tracks: [{
      id: trackId,
      name: "Designed For Me",
      approved_song_dna_version_id: dnaId,
      isrc: "US-SECRET-ISRC",
    }],
    song_dna_versions: [{
      id: dnaId,
      track_id: trackId,
      approval_state: "approved",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["house_general"],
      short_pitch: "approved pitch",
      primary_genre: "rap",
    }],
    discovery_profiles: [{
      id: "p1",
      profile_key: "rap_core",
      label: "Rap core",
      genre_family: "rap",
      approved_lanes: ["rap_general"],
      is_active: true,
      approval_status: "approved",
    }],
  });

  const res = await getPlaylistDiscoveryWork(sb, ops);
  assertEquals(res.status, 200);
  assertEquals(res.data.ok, true);
  const tracks = res.data.tracks as Record<string, unknown>[];
  assert(tracks.length >= 1);
  assertEquals(tracks[0].track_id, trackId);
  assertEquals(tracks[0].title, "Designed For Me");
  assertEquals(tracks[0].isrc, undefined);
  assertEquals("isrc" in tracks[0], false);
  const blob = JSON.stringify(res.data);
  assert(!blob.includes("US-SECRET-ISRC"));
  assert(!blob.includes("service_role"));
  assert(!blob.includes("SUPABASE_SERVICE_ROLE_KEY"));
});

Deno.test("MCP OAuth metadata binds playlist_discovery scope; no secret in URL", () => {
  withEnv({
    SUPABASE_URL: "https://vsemrziqxrrfcquxfnwd.supabase.co",
    AGH_MCP_PLAYLIST_DISCOVERY_URL: "",
  }, () => {
    Deno.env.delete("AGH_MCP_PLAYLIST_DISCOVERY_URL");
    const base = mcpPublicBaseUrl();
    assertEquals(
      base,
      "https://vsemrziqxrrfcquxfnwd.supabase.co/functions/v1/mcp-playlist-discovery",
    );
    assert(!base.includes("secret"));
    assert(!base.includes("service_role"));
    assertEquals(PLAYLIST_DISCOVERY_SCOPE, "playlist_discovery");

    const res = protectedResourceMetadata();
    assertEquals(res.resource, `${base}/mcp`);
    assertEquals(res.scopes_supported, ["playlist_discovery"]);

    const as = authorizationServerMetadata();
    assertEquals(as.authorization_endpoint, `${base}/oauth/authorize`);
    assertEquals(as.token_endpoint, `${base}/oauth/token`);
    assertEquals(as.registration_endpoint, `${base}/oauth/register`);
    assertEquals(as.code_challenge_methods_supported, ["S256"]);
  });
});

Deno.test("PKCE S256 challenge is deterministic for a verifier", async () => {
  const a = await pkceS256Challenge("verifier-abc");
  const b = await pkceS256Challenge("verifier-abc");
  assertEquals(a, b);
  assert(a.length > 20);
  const h = await sha256Hex("token");
  assertEquals(h.length, 64);
});

Deno.test("source files never embed service-role key in MCP connector URL design", async () => {
  const mcpSrc = await Deno.readTextFile(
    new URL("./playlist-discovery-mcp.ts", import.meta.url),
  );
  const oauthSrc = await Deno.readTextFile(new URL("./mcp-oauth.ts", import.meta.url));
  const edgeSrc = await Deno.readTextFile(
    new URL("../mcp-playlist-discovery/index.ts", import.meta.url),
  );
  for (const src of [mcpSrc, oauthSrc, edgeSrc]) {
    assert(!/eyJ[a-zA-Z0-9_-]{20,}\./.test(src), "no JWT-looking secrets in source");
    assert(!src.includes("service_role_key="));
    assert(!src.includes("?apikey="));
  }
  // Edge uses env SUPABASE_SERVICE_ROLE_KEY only server-side — never returned in JSON bodies.
  assert(edgeSrc.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert(edgeSrc.includes("claude_playlist_discovery"));
  assert(!edgeSrc.includes("tools/call") || edgeSrc.includes("runPlaylistDiscoveryTool"));
});

Deno.test("attributionFrom stamps claude_playlist_discovery not fendi/claude/service", () => {
  const a = attributionFrom(playlistDiscoveryActor());
  assertEquals(a.actor_kind, "claude_playlist_discovery");
  assertEquals(a.actor_label, "claude_playlist_discovery");
  assert(a.actor_kind !== "fendi");
  assert(a.actor_kind !== "claude");
  assert(a.actor_kind !== "service");
});
