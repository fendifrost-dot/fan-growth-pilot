// Deno tests for the Pitch Portal campaign guardrail (current-state DNA contract).
// Run: deno test supabase/functions/_shared/pitch-campaigns.test.ts
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeCampaignTrackNames,
  assertTrackHasActiveCampaign,
  buildCampaignConfigurationSnapshot,
  chicagoDayStartIso,
  evaluateCampaignConfig,
  isPitchCampaignAction,
  rejectCallerCampaignOverrides,
  rejectCallerCampaignPitchCopy,
  requireFendiActiveCampaignConfig,
  requireFendiCampaignActivation,
  runPitchCampaignAction,
} from "./pitch-campaigns.ts";
import type { OpsActor } from "./ops-actors.ts";

type Row = Record<string, unknown>;

// Minimal stub of the PostgREST builder surface these helpers actually touch.
// deno-lint-ignore no-explicit-any
function stubClient(tables: Record<string, any[]>, opts?: { insertCapture?: any[] }): any {
  const builder = (table: string) => {
    if (!tables[table]) tables[table] = [];
    let filters: Record<string, unknown> = {};
    const apply = () =>
      tables[table].filter((r) =>
        Object.entries(filters).every(([k, v]) => {
          if (Array.isArray(v)) return v.map(String).includes(String(r[k]));
          return String(r[k] ?? "") === String(v ?? "");
        })
      );
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        filters[col] = vals;
        return chain;
      },
      not: () => chain,
      order: () => chain,
      maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
      insert: (payload: unknown) => {
        opts?.insertCapture?.push(payload);
        const inserted = Array.isArray(payload) ? payload[0] : payload;
        const row = { id: "camp-1", ...(inserted as object) };
        tables[table].push(row);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: row, error: null }),
          }),
        };
      },
      update: (payload: unknown) => {
        opts?.insertCapture?.push({ _update: payload });
        return {
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            const matched = apply();
            const base = matched[0] ?? {};
            const updated = { ...base, ...(payload as object) };
            if (matched[0]) Object.assign(matched[0], payload as object);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: updated, error: null }),
              }),
            };
          },
        };
      },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: apply(), error: null }).then(resolve),
    };
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

function readyFixtures(extra: Record<string, Row[]> = {}) {
  return {
    tracks: [{
      id: "t1",
      name: "Fixture Track A",
      approved_song_dna_version_id: "dna-1",
    }],
    smart_links: [{ id: "l1", slug: "fixture-a", is_active: true }],
    song_dna_versions: [{
      id: "dna-1",
      track_id: "t1",
      approval_state: "approved",
      short_pitch: "Approved DNA pitch for fixture track.",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["kids"],
    }],
    pitch_campaigns: [],
    ...extra,
  };
}

function fendiOps(): OpsActor {
  return { kind: "fendi", userId: "fendi-user", label: "fendi" };
}
function adminOps(): OpsActor {
  return { kind: "human_admin", userId: "admin-user", label: "human_admin" };
}
function claudeOps(): OpsActor {
  return { kind: "claude_playlist_discovery", userId: null, label: "claude_playlist_discovery" };
}

Deno.test("isPitchCampaignAction only claims its own actions", () => {
  assert(isPitchCampaignAction("create_campaign"));
  assert(isPitchCampaignAction("list_campaigns"));
  assertEquals(isPitchCampaignAction("draft_pitch"), false);
  assertEquals(isPitchCampaignAction("list_tracks"), false);
});

Deno.test("chicagoDayStartIso returns an instant at or before now", () => {
  const now = new Date("2026-07-18T15:30:00Z");
  const start = chicagoDayStartIso(now);
  assert(start <= now.toISOString());
  assert(start.startsWith("2026-07-18T0"), `unexpected day start: ${start}`);
});

Deno.test("evaluateCampaignConfig refuses missing DNA, pitch, and smart link", async () => {
  const sb = stubClient({
    tracks: [{ id: "t1", name: "Fixture Track A", approved_song_dna_version_id: null }],
    smart_links: [],
    song_dna_versions: [],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", null);
  assert(cfg);
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing.sort(), ["approved_song_dna", "smart_link"]);
  assertEquals(cfg!.category_count, 0);
});

Deno.test("evaluateCampaignConfig refuses unapproved or stale DNA pointer", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Fixture Track A",
      approved_song_dna_version_id: "dna-stale",
    }],
    smart_links: [{ id: "l1", slug: "fixture-a", is_active: true }],
    song_dna_versions: [{
      id: "dna-stale",
      track_id: "t1",
      approval_state: "draft",
      short_pitch: "Should not count",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
    }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assertEquals(cfg!.ready, false);
  assert(cfg!.missing.includes("approved_song_dna"));
});

Deno.test("evaluateCampaignConfig refuses approved DNA without short_pitch", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Fixture Track A",
      approved_song_dna_version_id: "dna-1",
    }],
    smart_links: [{ id: "l1", slug: "fixture-a", is_active: true }],
    song_dna_versions: [{
      id: "dna-1",
      track_id: "t1",
      approval_state: "approved",
      short_pitch: "   ",
      approved_lanes: ["rap_general"],
      excluded_lanes: ["kids"],
    }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing, ["dna_short_pitch"]);
});

Deno.test("activation rejected with zero approved lanes (excluded alone insufficient)", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Fixture Track A",
      approved_song_dna_version_id: "dna-1",
    }],
    smart_links: [{ id: "l1", slug: "fixture-a", is_active: true }],
    song_dna_versions: [{
      id: "dna-1",
      track_id: "t1",
      approval_state: "approved",
      short_pitch: "Approved DNA pitch for fixture track.",
      approved_lanes: [],
      excluded_lanes: ["kids", "gospel"],
    }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing, ["approved_lanes"]);
  assertEquals(cfg!.excluded_lanes, ["kids", "gospel"]);

  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const inserts: unknown[] = [];
    const createSb = stubClient({
      tracks: [{
        id: "t1",
        name: "Fixture Track A",
        approved_song_dna_version_id: "dna-1",
      }],
      smart_links: [{ id: "l1", slug: "fixture-a", is_active: true }],
      song_dna_versions: [{
        id: "dna-1",
        track_id: "t1",
        approval_state: "approved",
        short_pitch: "Approved DNA pitch for fixture track.",
        approved_lanes: [],
        excluded_lanes: ["kids"],
      }],
      pitch_campaigns: [],
    }, { insertCapture: inserts });
    const res = await runPitchCampaignAction(
      "create_campaign",
      { track_id: "t1", smart_link_id: "l1", status: "active" },
      createSb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(res.status, 400);
    assertEquals((res.data.missing as string[]), ["approved_lanes"]);
    assertEquals(inserts.length, 0);
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("activation accepted with approved DNA pitch, at least one lane, and active smart link", async () => {
  const sb = stubClient(readyFixtures());
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assert(cfg);
  assertEquals(cfg!.ready, true);
  assertEquals(cfg!.missing, []);
  assertEquals(cfg!.song_dna_version_id, "dna-1");
  assertEquals(cfg!.dna_short_pitch, "Approved DNA pitch for fixture track.");
  assertEquals(cfg!.approved_lanes, ["rap_general"]);
  assertEquals(cfg!.excluded_lanes, ["kids"]);
  assertEquals(cfg!.smart_link_url, "https://links.fendifrost.com/fixture-a");
  assertEquals(cfg!.category_count, 0);

  const inserts: unknown[] = [];
  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const createSb = stubClient(readyFixtures(), { insertCapture: inserts });
    const res = await runPitchCampaignAction(
      "create_campaign",
      { track_id: "t1", smart_link_id: "l1", status: "active" },
      createSb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(res.status, 200);
    const row = inserts[0] as Record<string, unknown>;
    assertEquals(row.status, "active");
    assertEquals(row.song_dna_version_id, "dna-1");
    const snap = row.configuration_snapshot as Record<string, unknown>;
    assertEquals(snap.approved_lanes, ["rap_general"]);
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("an inactive smart link does not satisfy the guardrail", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Fixture Track A",
      approved_song_dna_version_id: "dna-1",
    }],
    smart_links: [{ id: "l1", slug: "fixture-a", is_active: false }],
    song_dna_versions: [{
      id: "dna-1",
      track_id: "t1",
      approval_state: "approved",
      short_pitch: "copy",
      approved_lanes: ["rap_general"],
      excluded_lanes: [],
    }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing, ["smart_link"]);
});

Deno.test("configuration snapshot is server-generated from DNA + smart link", () => {
  const snap = buildCampaignConfigurationSnapshot({
    ready: true,
    missing: [],
    track_id: "t1",
    track_name: "Fixture Track A",
    has_smart_link: true,
    smart_link_id: "l1",
    smart_link_url: "https://links.fendifrost.com/fixture-a",
    smart_link_slug: "fixture-a",
    song_dna_version_id: "dna-1",
    has_approved_dna: true,
    has_dna_pitch_copy: true,
    approved_lanes: ["rap_general"],
    excluded_lanes: [],
    dna_short_pitch: "Approved DNA pitch for fixture track.",
    category_count: 0,
    has_pitch_copy: true,
  });
  assertEquals(snap.snapshot_source, "server_activation");
  assertEquals(snap.song_dna_version_id, "dna-1");
  assertEquals(snap.short_pitch, "Approved DNA pitch for fixture track.");
  assertEquals(snap.smart_link_id, "l1");
  const banned = ["med" + "itate", "designed for me"];
  for (const term of banned) {
    assert(!JSON.stringify(snap).toLowerCase().includes(term));
  }
});

Deno.test("rejectCallerCampaignPitchCopy blocks caller pitch fields", () => {
  const denied = rejectCallerCampaignPitchCopy({ pitch_copy: "nope" });
  assert(denied);
  assertEquals(denied!.status, 422);
  assertEquals(rejectCallerCampaignPitchCopy({ notes: "ok" }), null);
});

Deno.test("caller-supplied snapshot and pitch copy remain rejected", async () => {
  assertEquals(rejectCallerCampaignOverrides({ configuration_snapshot: { x: 1 } })?.status, 422);
  assertEquals(rejectCallerCampaignOverrides({ song_dna_version_id: "dna-spoof" })?.status, 422);
  assertEquals(rejectCallerCampaignOverrides({ pitch_copy: "nope" })?.status, 422);

  const sb = stubClient(readyFixtures({
    pitch_campaigns: [{
      id: "camp-1",
      track_id: "t1",
      smart_link_id: "l1",
      status: "active",
      started_at: "2026-09-01T00:00:00Z",
      activated_at: "2026-09-01T00:00:00Z",
    }],
  }));
  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const snapRes = await runPitchCampaignAction(
      "update_campaign",
      {
        campaign_id: "camp-1",
        smart_link_id: "l2",
        configuration_snapshot: { forged: true },
      },
      sb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(snapRes.status, 422);
    assertEquals(snapRes.data.code, "caller_snapshot_rejected");

    const copyRes = await runPitchCampaignAction(
      "create_campaign",
      { track_id: "t1", pitch_copy: "fabricated" },
      stubClient(readyFixtures()),
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(copyRes.status, 422);
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("requireFendiCampaignActivation is Fendi-only", () => {
  assertEquals(requireFendiCampaignActivation(fendiOps()), null);
  assertEquals(requireFendiCampaignActivation(adminOps())?.status, 403);
  assertEquals(requireFendiCampaignActivation(claudeOps())?.status, 403);
  assertEquals(requireFendiActiveCampaignConfig(adminOps())?.status, 403);
  assertEquals(requireFendiActiveCampaignConfig(fendiOps()), null);
});

Deno.test("create_campaign activation refused for non-Fendi", async () => {
  const inserts: unknown[] = [];
  const sb = stubClient(readyFixtures(), { insertCapture: inserts });

  const res = await runPitchCampaignAction(
    "create_campaign",
    { track_id: "t1", smart_link_id: "l1", status: "active" },
    sb,
    { kind: "user", userId: "admin-user", isAdmin: true },
    null,
  );
  assertEquals(res.status, 403);
  assertEquals(inserts.length, 0);
});

Deno.test("create_campaign Fendi activation binds DNA and server snapshot", async () => {
  const inserts: unknown[] = [];
  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const sb = stubClient(readyFixtures(), { insertCapture: inserts });
    const res = await runPitchCampaignAction(
      "create_campaign",
      { track_id: "t1", smart_link_id: "l1", status: "active" },
      sb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(res.status, 200);
    assertEquals(inserts.length, 1);
    const row = inserts[0] as Record<string, unknown>;
    assertEquals(row.status, "active");
    assertEquals(row.song_dna_version_id, "dna-1");
    assertEquals(row.created_by, "fendi-user");
    assertEquals(row.approved_by, "fendi-user");
    const snap = row.configuration_snapshot as Record<string, unknown>;
    assertEquals(snap.snapshot_source, "server_activation");
    assertEquals(snap.short_pitch, "Approved DNA pitch for fixture track.");
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("active smart-link change rejected for non-Fendi", async () => {
  const writes: unknown[] = [];
  const sb = stubClient({
    ...readyFixtures({
      pitch_campaigns: [{
        id: "camp-1",
        track_id: "t1",
        smart_link_id: "l1",
        status: "active",
        started_at: "2026-09-01T00:00:00Z",
        activated_at: "2026-09-01T00:00:00Z",
      }],
      smart_links: [
        { id: "l1", slug: "fixture-a", is_active: true },
        { id: "l2", slug: "fixture-b", is_active: true },
      ],
    }),
  }, { insertCapture: writes });

  const res = await runPitchCampaignAction(
    "update_campaign",
    { campaign_id: "camp-1", smart_link_id: "l2" },
    sb,
    { kind: "user", userId: "admin-user", isAdmin: true },
    null,
  );
  assertEquals(res.status, 403);
  assertEquals(res.data.code, "fendi_active_config_required");
  assertEquals(writes.length, 0);
});

Deno.test("inactive smart-link change rejected on active campaign", async () => {
  const writes: unknown[] = [];
  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const sb = stubClient({
      ...readyFixtures({
        pitch_campaigns: [{
          id: "camp-1",
          track_id: "t1",
          smart_link_id: "l1",
          status: "active",
          started_at: "2026-09-01T00:00:00Z",
          activated_at: "2026-09-01T00:00:00Z",
        }],
        smart_links: [
          { id: "l1", slug: "fixture-a", is_active: true },
          { id: "l2", slug: "fixture-dead", is_active: false },
        ],
      }),
    }, { insertCapture: writes });

    const res = await runPitchCampaignAction(
      "update_campaign",
      { campaign_id: "camp-1", smart_link_id: "l2" },
      sb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(res.status, 400);
    assertEquals(res.data.code, "active_smart_link_invalid");
    assert((res.data.missing as string[]).includes("smart_link"));
    assertEquals(writes.length, 0);
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("valid Fendi smart-link change refreshes DNA binding and snapshot", async () => {
  const writes: unknown[] = [];
  Deno.env.set("ARTIST_USER_ID", "fendi-user");
  try {
    const sb = stubClient({
      tracks: [{
        id: "t1",
        name: "Fixture Track A",
        approved_song_dna_version_id: "dna-2",
      }],
      smart_links: [
        { id: "l1", slug: "fixture-a", is_active: true },
        { id: "l2", slug: "fixture-b", is_active: true },
      ],
      song_dna_versions: [{
        id: "dna-2",
        track_id: "t1",
        approval_state: "approved",
        short_pitch: "Refreshed DNA pitch for fixture track.",
        approved_lanes: ["rap_general", "trap"],
        excluded_lanes: [],
      }],
      pitch_campaigns: [{
        id: "camp-1",
        track_id: "t1",
        smart_link_id: "l1",
        song_dna_version_id: "dna-old",
        status: "active",
        started_at: "2026-09-01T00:00:00Z",
        activated_at: "2026-09-01T00:00:00Z",
        configuration_snapshot: { snapshot_source: "stale" },
      }],
    }, { insertCapture: writes });

    const res = await runPitchCampaignAction(
      "update_campaign",
      { campaign_id: "camp-1", smart_link_id: "l2" },
      sb,
      { kind: "user", userId: "fendi-user", isAdmin: true },
      null,
    );
    assertEquals(res.status, 200);
    assertEquals(writes.length, 1);
    const patch = (writes[0] as { _update: Record<string, unknown> })._update;
    assertEquals(patch.smart_link_id, "l2");
    assertEquals(patch.song_dna_version_id, "dna-2");
    assertEquals(patch.approved_by, "fendi-user");
    const snap = patch.configuration_snapshot as Record<string, unknown>;
    assertEquals(snap.snapshot_source, "server_activation");
    assertEquals(snap.smart_link_id, "l2");
    assertEquals(snap.smart_link_slug, "fixture-b");
    assertEquals(snap.song_dna_version_id, "dna-2");
    assertEquals(snap.short_pitch, "Refreshed DNA pitch for fixture track.");
    assertEquals(snap.approved_lanes, ["rap_general", "trap"]);
  } finally {
    Deno.env.delete("ARTIST_USER_ID");
  }
});

Deno.test("activeCampaignTrackNames lowercases and skips blanks", async () => {
  const sb = stubClient({
    pitch_campaigns: [
      { status: "active", tracks: { name: "Fixture Track A" } },
      { status: "active", tracks: { name: "  Fixture Track B  " } },
      { status: "active", tracks: null },
    ],
  });
  const names = await activeCampaignTrackNames(sb);
  assertEquals(names.size, 2);
  assert(names.has("fixture track a"));
  assert(names.has("fixture track b"));
});

Deno.test("assertTrackHasActiveCampaign rejects an un-campaigned song", async () => {
  const sb = stubClient({ pitch_campaigns: [] });
  await assertRejects(
    () => assertTrackHasActiveCampaign(sb, { trackName: "Some Random Song" }),
    Error,
    "No active pitch campaign",
  );
});

Deno.test("assertTrackHasActiveCampaign passes a campaigned song by name", async () => {
  const sb = stubClient({
    pitch_campaigns: [{ status: "active", tracks: { name: "Fixture Track A" } }],
  });
  await assertTrackHasActiveCampaign(sb, { trackName: "fixture track a" });
});

Deno.test("assertTrackHasActiveCampaign requires an identifier", async () => {
  const sb = stubClient({ pitch_campaigns: [] });
  await assertRejects(
    () => assertTrackHasActiveCampaign(sb, {}),
    Error,
    "track_id or track_name required",
  );
});

Deno.test("no hard-coded production song titles or pitch copy in campaign module", async () => {
  const src = await Deno.readTextFile(new URL("./pitch-campaigns.ts", import.meta.url));
  const lower = src.toLowerCase();
  const banned = ["med" + "itate", "designed for me", "designedforme"];
  for (const term of banned) {
    assert(!lower.includes(term), `campaign module must not hard-code ${term}`);
  }
});
