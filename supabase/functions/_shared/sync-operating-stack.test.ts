/**
 * AGH authenticated sync operating stack — authorization, eligibility,
 * config-driven Meditate-only selection, opportunity typing, and denial matrix.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
  attributionFrom,
} from "./ops-actors.ts";
import { ACTION_SPEC, authorizeAction, requiredCapabilityForAction } from "./outreach-auth.ts";
import { authorizeStationOperator } from "./chicago-time.ts";
import { evaluateSyncEligibility } from "./sync-eligibility.ts";
import {
  parseSyncResearchConfig,
  isActiveResearchTrack,
  activeResearchTrackIds,
  rejectCallerSyncIdentity,
  SYNC_RESEARCH_SETTING_KEY,
} from "./sync-research-config.ts";
import {
  SYNC_RESEARCH_ACTIONS,
  isOpportunityType,
  opportunityDedupeKey,
  syncTargetDedupeKey,
  createSyncTarget,
  createSyncOpportunity,
  draftSyncPitch,
  getSyncDiscoveryWork,
} from "./sync-research.ts";
import { SYNC_CONTROL_ACTIONS, isSyncControlAction } from "./sync-control.ts";
import { SYNC_GATE_ACTIONS, isSyncGateAction } from "./sync-gate.ts";
import {
  SYNC_DISCOVERY_TOOLS,
  syncDiscoveryActor,
  isSyncDiscoveryTool,
} from "./sync-discovery-mcp.ts";
import { PLAYLIST_DISCOVERY_TOOLS } from "./playlist-discovery-mcp.ts";
import {
  PLAYLIST_DISCOVERY_SCOPE,
  SYNC_DISCOVERY_SCOPE,
  actorForScope,
  isAllowedMcpScope,
} from "./mcp-oauth.ts";

const MEDITATE_ID = "506ad12f-9e2e-450c-b2e9-f3d10670c015";
const DFM_ID = "5d09da7e-98cf-4276-8dca-861d1fbbfa98";
const PRADA_ID = "dc36a2c5-f07e-40da-a1b4-0c46c67fadd8";

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

/** Minimal in-memory stub covering sync research tables + ops_settings + tracks. */
function mockSb(store: {
  settings?: Record<string, unknown>;
  tracks?: Record<string, unknown>[];
  targets?: Record<string, unknown>[];
  opportunities?: Record<string, unknown>[];
  drafts?: Record<string, unknown>[];
  dna?: Record<string, unknown>[];
  licenses?: Record<string, unknown>[];
  batches?: Record<string, unknown>[];
  records?: Record<string, unknown>[];
}) {
  const state = {
    settings: store.settings ?? {},
    tracks: store.tracks ?? [],
    targets: store.targets ?? [],
    opportunities: store.opportunities ?? [],
    drafts: store.drafts ?? [],
    dna: store.dna ?? [],
    licenses: store.licenses ?? [],
    batches: store.batches ?? [],
    records: store.records ?? [],
  };

  function table(name: string) {
    const rows = (): Record<string, unknown>[] => {
      switch (name) {
        case "ops_settings":
          return Object.entries(state.settings).map(([k, v]) => ({
            setting_key: k,
            setting_value: v,
          }));
        case "tracks":
          return state.tracks;
        case "sync_research_targets":
          return state.targets;
        case "sync_research_opportunities":
          return state.opportunities;
        case "sync_research_pitch_drafts":
          return state.drafts;
        case "song_dna_versions":
          return state.dna;
        case "private_license_evidence":
          return state.licenses;
        case "agh_handoff_batches":
          return state.batches;
        case "agh_handoff_records":
          return state.records;
        default:
          return [];
      }
    };

    const filters: { col: string; op: string; val: unknown }[] = [];
    let limitN = 200;
    let orderAsc = false;

    const api: Record<string, unknown> = {
      select(_cols?: string) {
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, op: "eq", val });
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ col, op: "in", val: vals });
        return api;
      },
      not(col: string, op: string, val: unknown) {
        filters.push({ col, op: `not_${op}`, val });
        return api;
      },
      order(_c: string, opts?: { ascending?: boolean }) {
        orderAsc = Boolean(opts?.ascending);
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      maybeSingle: async () => {
        const matched = apply(rows(), filters).slice(0, 1);
        return { data: matched[0] ?? null, error: null };
      },
      single: async () => {
        const matched = apply(rows(), filters).slice(0, 1);
        if (!matched[0]) return { data: null, error: { message: "not found" } };
        return { data: matched[0], error: null };
      },
      then: undefined as unknown,
      insert(row: Record<string, unknown> | Record<string, unknown>[]) {
        const list = Array.isArray(row) ? row : [row];
        const inserted = list.map((r) => ({
          id: r.id ?? crypto.randomUUID(),
          created_at: new Date().toISOString(),
          ...r,
        }));
        if (name === "sync_research_targets") state.targets.push(...inserted);
        if (name === "sync_research_opportunities") state.opportunities.push(...inserted);
        if (name === "sync_research_pitch_drafts") state.drafts.push(...inserted);
        if (name === "agh_handoff_batches") state.batches.push(...inserted);
        if (name === "agh_handoff_records") state.records.push(...inserted);
        return {
          select: () => ({
            single: async () => ({ data: inserted[0], error: null }),
            maybeSingle: async () => ({ data: inserted[0], error: null }),
          }),
          then: async (resolve: (v: unknown) => void) =>
            resolve({ data: inserted, error: null }),
        };
      },
      update(patch: Record<string, unknown>) {
        return {
          eq(col: string, val: unknown) {
            const matched = apply(rows(), [...filters, { col, op: "eq", val }]);
            for (const m of matched) Object.assign(m, patch);
            return {
              select: () => ({
                single: async () => ({ data: matched[0] ?? null, error: matched[0] ? null : { message: "missing" } }),
                maybeSingle: async () => ({ data: matched[0] ?? null, error: null }),
              }),
              in() {
                return {
                  then: async (resolve: (v: unknown) => void) => resolve({ data: matched, error: null }),
                };
              },
              then: async (resolve: (v: unknown) => void) =>
                resolve({ data: matched, error: null }),
            };
          },
          in(col: string, vals: unknown[]) {
            const matched = apply(rows(), [...filters, { col, op: "in", val: vals }]);
            for (const m of matched) Object.assign(m, patch);
            return {
              then: async (resolve: (v: unknown) => void) =>
                resolve({ data: matched, error: null }),
            };
          },
        };
      },
    };

    // Make thenable for `const { data } = await q`
    (api as { then: unknown }).then = (
      resolve: (v: { data: unknown; error: null }) => void,
    ) => {
      const matched = apply(rows(), filters).slice(0, limitN);
      if (!orderAsc) matched.reverse();
      resolve({ data: matched, error: null });
    };

    return api;
  }

  function apply(
    list: Record<string, unknown>[],
    filters: { col: string; op: string; val: unknown }[],
  ) {
    return list.filter((row) =>
      filters.every((f) => {
        if (f.op === "eq") return row[f.col] === f.val;
        if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
        if (f.op === "not_is") return row[f.col] != null;
        return true;
      })
    );
  }

  return {
    from: (name: string) => table(name),
    _state: state,
  } as unknown as {
    from: (n: string) => unknown;
    _state: typeof state;
  };
}

const defaultConfig = {
  version: 1,
  default_status: "inactive",
  tracks: {
    [MEDITATE_ID]: { status: "active_research", label: "Meditate" },
    [DFM_ID]: { status: "inactive", label: "Designed For Me (Control)" },
    [PRADA_ID]: {
      status: "blocked",
      label: "Neva Too Much Prada",
      notes: "Blocked until verified private-license evidence and Fendi approval",
    },
  },
};

Deno.test("config: Meditate-only active_research from ops_settings — no title hardcode", () => {
  const cfg = parseSyncResearchConfig(defaultConfig);
  assertEquals(isActiveResearchTrack(cfg, MEDITATE_ID), true);
  assertEquals(isActiveResearchTrack(cfg, DFM_ID), false);
  assertEquals(isActiveResearchTrack(cfg, PRADA_ID), false);
  assertEquals(activeResearchTrackIds(cfg), [MEDITATE_ID]);
  assertEquals(SYNC_RESEARCH_SETTING_KEY, "sync_research_config");
  // Changing configured track is data-only
  const swapped = parseSyncResearchConfig({
    ...defaultConfig,
    tracks: {
      [DFM_ID]: { status: "active_research" },
      [MEDITATE_ID]: { status: "inactive" },
    },
  });
  assertEquals(activeResearchTrackIds(swapped), [DFM_ID]);
});

Deno.test("eligibility: blocked without Fendi approvals / readiness; no caller has_sample trust", () => {
  const blocked = evaluateSyncEligibility({
    track: {
      id: MEDITATE_ID,
      approved_song_dna_version_id: "dna-1",
      has_sample: "no",
      assets_ready: false,
      splits_ready: false,
      publishing_ready: false,
      unresolved_rights_exception: false,
    },
    dna: {
      id: "dna-1",
      approval_state: "approved",
      sample_declaration: "no",
      sync_recommendation: "candidate",
      payload: {},
    },
    privateLicenseVerified: false,
  });
  assertEquals(blocked.eligible, false);
  assert(blocked.blockers.includes("fendi_sample_declaration_approval"));
  assert(blocked.blockers.includes("fendi_sync_approval"));
  assert(blocked.blockers.includes("required_splits"));
  assert(blocked.blockers.includes("publishing_readiness"));
  assert(blocked.blockers.includes("asset_readiness"));

  const ready = evaluateSyncEligibility({
    track: {
      id: MEDITATE_ID,
      approved_song_dna_version_id: "dna-1",
      has_sample: "no",
      assets_ready: true,
      splits_ready: true,
      publishing_ready: true,
      unresolved_rights_exception: false,
      sample_declaration_approved_at: "2026-09-01T00:00:00Z",
      sample_declaration_approved_by: "fendi",
      sync_approved_at: "2026-09-01T00:00:00Z",
      sync_approved_by: "fendi",
    },
    dna: {
      id: "dna-1",
      approval_state: "approved",
      sample_declaration: "no",
      sync_recommendation: "approved",
      payload: {},
    },
    privateLicenseVerified: false,
  });
  assertEquals(ready.eligible, true);
  assertEquals(ready.blockers, []);
});

Deno.test("opportunity types: active_brief vs agency_introduction remain distinct", () => {
  assertEquals(isOpportunityType("active_brief"), true);
  assertEquals(isOpportunityType("agency_introduction"), true);
  assertEquals(isOpportunityType("undated_directory"), false);
  const a = opportunityDedupeKey({
    opportunity_type: "active_brief",
    project_brief: "Netflix trailer cue",
    source_url: "https://example.com/brief",
    deadline: "2026-10-01",
  });
  const b = opportunityDedupeKey({
    opportunity_type: "agency_introduction",
    project_brief: "Netflix trailer cue",
    source_url: "https://example.com/brief",
  });
  assert(a !== b, "typed dedupe keys must differ");
});

Deno.test("claude_sync_discovery can research but cannot approve/send/eligibility", () => {
  withEnv({ CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-claude-sync-discovery-secret": "sync-secret" }));
    assertEquals(actor.kind, "claude_sync_discovery");
    assertEquals(can(actor, "research_sync_targets"), true);
    assertEquals(can(actor, "create_sync_opportunity"), true);
    assertEquals(can(actor, "draft_sync_pitch"), true);
    assertEquals(can(actor, "read_sync_discovery_work"), true);
    assertEquals(can(actor, "advance_sync_batch"), true);
    assertEquals(can(actor, "approve_sync_outreach"), false);
    assertEquals(can(actor, "submit_sync_outreach"), false);
    assertEquals(can(actor, "approve_sync_eligibility"), false);
    assertEquals(can(actor, "approve_song_dna"), false);
    assertEquals(can(actor, "approve_sample_declaration"), false);
    assertEquals(can(actor, "send_playlist_pitches"), false);
    assertEquals(can(actor, "read_playlist_discovery_work"), false);
  });
});

Deno.test("Grok can review/submit sync outreach but cannot set Fendi-only fields", () => {
  withEnv({ GROK_PLAYLIST_CONTROL_SECRET: "grok-secret" }, () => {
    const actor = resolveOpsActor(null, req({ "x-grok-playlist-control-secret": "grok-secret" }));
    assertEquals(can(actor, "review_sync_outreach"), true);
    assertEquals(can(actor, "approve_sync_outreach"), true);
    assertEquals(can(actor, "submit_sync_outreach"), true);
    assertEquals(can(actor, "track_sync_responses"), true);
    assertEquals(can(actor, "escalate_sync_to_fendi"), true);
    assertEquals(can(actor, "approve_sync_eligibility"), false);
    assertEquals(can(actor, "approve_sample_declaration"), false);
    assertEquals(can(actor, "approve_song_dna"), false);
    assertEquals(can(actor, "alter_approved_song_dna"), false);
    assertEquals(can(actor, "authorize_monetary_decisions"), false);
  });
});

Deno.test("Fendi-only sync eligibility cannot be spoofed via attribution or headers", () => {
  withEnv({
    ARTIST_USER_ID: "fendi-exact-id",
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    GROK_PLAYLIST_CONTROL_SECRET: "grok-secret",
  }, () => {
    const claude = resolveOpsActor(null, req({
      "x-claude-sync-discovery-secret": "sync-secret",
      "x-agh-agent": "fendi",
    }));
    assertEquals(claude.kind, "claude_sync_discovery");
    assertEquals(can(claude, "approve_sync_eligibility"), false);

    const cleaned = stripSpoofedAttribution({
      track_id: MEDITATE_ID,
      approved_by: "fendi",
      sync_eligible: true,
      discovered_by: "attacker",
    });
    assertEquals(cleaned.approved_by, undefined);
    assertEquals(cleaned.discovered_by, undefined);
    assertEquals(rejectCallerSyncIdentity({ sync_eligible: true }), "caller-supplied sync_eligible is rejected");
    assertEquals(rejectCallerSyncIdentity({ has_sample: "no" }), "caller-supplied has_sample is rejected");

    const fendi = resolveOpsActor(
      { kind: "user", userId: "fendi-exact-id", isAdmin: true },
      null,
    );
    assertEquals(fendi.kind, "fendi");
    assertEquals(can(fendi, "approve_sync_eligibility"), true);
    assertEquals(can(fendi, "approve_sample_declaration"), true);
  });
});

Deno.test("ACTION_SPEC covers sync research, control, and gate actions", () => {
  for (const action of [
    ...SYNC_RESEARCH_ACTIONS,
    ...SYNC_CONTROL_ACTIONS,
    ...SYNC_GATE_ACTIONS,
  ]) {
    assert(ACTION_SPEC[action], `missing ACTION_SPEC for ${action}`);
    assert(requiredCapabilityForAction(action), `missing capability for ${action}`);
  }
  assertEquals(isSyncControlAction("approve_sync_outreach"), true);
  assertEquals(isSyncGateAction("approve_sync_eligibility"), true);
});

Deno.test("playlist discovery tools uninterrupted; sync MCP tools are separate", () => {
  assert(PLAYLIST_DISCOVERY_TOOLS.includes("get_playlist_discovery_work"));
  assert(SYNC_DISCOVERY_TOOLS.includes("get_sync_discovery_work"));
  assertEquals(isSyncDiscoveryTool("get_playlist_discovery_work"), false);
  assertEquals(actorForScope(PLAYLIST_DISCOVERY_SCOPE), "claude_playlist_discovery");
  assertEquals(actorForScope(SYNC_DISCOVERY_SCOPE), "claude_sync_discovery");
  assertEquals(isAllowedMcpScope("sync_discovery"), true);
  const pd = syncDiscoveryActor();
  assertEquals(pd.kind, "claude_sync_discovery");
  assertEquals(can(pd, "send_playlist_pitches"), false);
});

Deno.test("noon sync station: claude_sync_discovery may complete; playlist-discovery may not", () => {
  assertEquals(
    authorizeStationOperator("sync_batch_ready", "claude_sync_discovery", "complete"),
    null,
  );
  assert(
    authorizeStationOperator("sync_batch_ready", "claude_playlist_discovery", "complete") != null,
  );
  assertEquals(
    authorizeStationOperator("playlist_discovery_begin", "claude_playlist_discovery", "complete"),
    null,
  );
  assert(
    authorizeStationOperator("playlist_discovery_begin", "claude_sync_discovery", "complete") !=
      null,
  );
  assertEquals(
    authorizeStationOperator("grok_sync_review", "grok_playlist_control", "complete"),
    null,
  );
  assert(
    authorizeStationOperator("grok_sync_send", "claude_sync_discovery", "complete") != null,
  );
});

Deno.test("DB-backed: Claude can persist targets while eligibility is blocked", async () => {
  const sb = mockSb({
    settings: { sync_research_config: defaultConfig },
    tracks: [
      {
        id: MEDITATE_ID,
        name: "Meditate",
        approved_song_dna_version_id: "dna-1",
        sync_eligible: false,
        has_sample: "no",
        assets_ready: false,
        splits_ready: false,
        publishing_ready: false,
      },
    ],
    dna: [
      {
        id: "dna-1",
        approval_state: "approved",
        sample_declaration: "no",
        sync_recommendation: "blocked",
        primary_genre: "hip_hop_rap",
        approved_lanes: ["rap"],
        excluded_lanes: ["house"],
        mood_tags: ["night"],
        context_tags: [],
        short_pitch: "late-night rap",
        payload: {},
      },
    ],
  });
  const ops = {
    kind: "claude_sync_discovery" as const,
    userId: null,
    label: "claude_sync_discovery",
  };

  const work = await getSyncDiscoveryWork(sb as never, ops);
  assertEquals(work.status, 200);
  assertEquals((work.data.active_research_track_ids as string[])[0], MEDITATE_ID);
  assertEquals((work.data.tracks as { may_draft_outreach: boolean }[])[0].may_draft_outreach, false);

  const target = await createSyncTarget(
    sb as never,
    {
      person_name: "Alex Supervisor",
      company_name: "Sync House",
      role_category: "music_supervisor",
      official_url: "https://example.com/alex",
      verified_contact_path: "alex@example.com",
      source_evidence: "company contact page 2026-09-11",
      associated_track_id: MEDITATE_ID,
      discovered_by: "spoof-should-strip",
    },
    ops,
  );
  assertEquals(target.status, 200);
  assertEquals(target.data.created, true);
  const row = target.data.row as { discovered_by: string; dedupe_key: string };
  assertEquals(row.discovered_by, "claude_sync_discovery");

  // Idempotent duplicate
  const again = await createSyncTarget(
    sb as never,
    {
      person_name: "Alex Supervisor",
      company_name: "Sync House",
      role_category: "music_supervisor",
      official_url: "https://example.com/alex",
      verified_contact_path: "alex@example.com",
      associated_track_id: MEDITATE_ID,
    },
    ops,
  );
  assertEquals(again.data.collapsed, true);

  // Agency introduction OK without deadline
  const intro = await createSyncOpportunity(
    sb as never,
    {
      opportunity_type: "agency_introduction",
      project_brief: "Open to hip-hop placements",
      source_url: "https://example.com/policy",
      source_evidence: "submission policy page",
      associated_track_id: MEDITATE_ID,
    },
    ops,
  );
  assertEquals(intro.status, 200);

  // Undated cannot be active_brief
  const badBrief = await createSyncOpportunity(
    sb as never,
    {
      opportunity_type: "active_brief",
      project_brief: "Trailer cue — undated",
      source_url: "https://example.com/x",
      source_evidence: "listing",
      associated_track_id: MEDITATE_ID,
    },
    ops,
  );
  assertEquals(badBrief.status, 422);
  assertEquals(badBrief.data.code, "active_brief_requires_deadline");

  // Draft fails closed while ineligible
  const draft = await draftSyncPitch(
    sb as never,
    {
      opportunity_id: (intro.data.row as { id: string }).id,
      track_id: MEDITATE_ID,
      body: "Pitch body for Meditate sync.",
      sync_eligible: true, // rejected
    },
    ops,
  );
  assertEquals(draft.status, 400);
  assertStringIncludes(String(draft.data.error), "sync_eligible");

  const draft2 = await draftSyncPitch(
    sb as never,
    {
      opportunity_id: (intro.data.row as { id: string }).id,
      track_id: MEDITATE_ID,
      body: "Pitch body for Meditate sync.",
    },
    ops,
  );
  assertEquals(draft2.status, 422);
  assertEquals(draft2.data.code, "sync_eligibility_blocked");
  assertEquals(draft2.data.drafted, false);
  assertEquals(draft2.data.inferred_eligibility, false);
});

Deno.test("inactive / blocked configured tracks reject research association", async () => {
  const sb = mockSb({
    settings: { sync_research_config: defaultConfig },
    tracks: [{ id: PRADA_ID, name: "Neva Too Much Prada" }],
  });
  const ops = {
    kind: "claude_sync_discovery" as const,
    userId: null,
    label: "claude_sync_discovery",
  };
  const res = await createSyncTarget(
    sb as never,
    {
      person_name: "Lib Contact",
      company_name: "Library",
      role_category: "production_music_library",
      official_url: "https://example.com/lib",
      verified_contact_path: "lib@example.com",
      source_evidence: "site",
      associated_track_id: PRADA_ID,
    },
    ops,
  );
  assertEquals(res.status, 422);
  assertEquals(res.data.code, "sync_research_track_inactive");
});

Deno.test("attributionFrom never uses caller input", () => {
  const ops = {
    kind: "claude_sync_discovery" as const,
    userId: null,
    label: "claude_sync_discovery",
  };
  const attr = attributionFrom(ops);
  assertEquals(attr.actor_kind, "claude_sync_discovery");
  assertEquals(
    syncTargetDedupeKey({
      person_name: "A",
      company_name: "B",
      role_category: "music_supervisor",
      official_url: "https://x",
      verified_contact_path: "a@b.c",
    }).includes("music_supervisor"),
    true,
  );
});

Deno.test("authorizeAction denies Claude sync approve/submit", async () => {
  await withEnv({
    CLAUDE_SYNC_DISCOVERY_SECRET: "sync-secret",
    ARTIST_USER_ID: "fendi-exact-id",
  }, async () => {
    const fakeSb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) } as never;
    const denied = await authorizeAction(
      "approve_sync_outreach",
      req({ "x-claude-sync-discovery-secret": "sync-secret" }),
      fakeSb,
    );
    assertEquals(denied.ok, false);

    const gateDenied = await authorizeAction(
      "approve_sync_eligibility",
      req({ "x-claude-sync-discovery-secret": "sync-secret" }),
      fakeSb,
    );
    assertEquals(gateDenied.ok, false);
  });
});
