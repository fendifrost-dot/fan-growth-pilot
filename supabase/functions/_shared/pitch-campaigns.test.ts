// Deno tests for the Pitch Portal campaign guardrail.
// Run: deno test supabase/functions/_shared/pitch-campaigns.test.ts
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeCampaignTrackNames,
  assertSendCampaignIdentity,
  assertTrackHasActiveCampaign,
  chicagoDayStartIso,
  evaluateCampaignConfig,
  isPitchCampaignAction,
  runPitchCampaignAction,
} from "./pitch-campaigns.ts";

// Minimal stub of the PostgREST builder surface these helpers actually touch.
// Each table maps to the rows a .select() should resolve to.
// deno-lint-ignore no-explicit-any
function stubClient(tables: Record<string, any[]>, opts?: { insertError?: string }): any {
  const builder = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      not: () => chain,
      order: () => chain,
      insert: (row: unknown) => {
        const inserted = Array.isArray(row) ? row[0] : row;
        (tables._lastInsert ??= []).push(inserted);
        const out = { ...(inserted as object), id: "new-campaign" };
        const after = {
          select: () => ({
            single: () =>
              opts?.insertError
                ? Promise.resolve({ data: null, error: { message: opts.insertError } })
                : Promise.resolve({ data: out, error: null }),
          }),
        };
        return after;
      },
      update: () => ({
        eq: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
          }),
        }),
      }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  };
  return { from: (table: string) => builder(tables[table] ?? []) };
}

Deno.test("isPitchCampaignAction only claims its own actions", () => {
  assert(isPitchCampaignAction("create_campaign"));
  assert(isPitchCampaignAction("list_campaigns"));
  // Must not shadow actions owned by the playlist-agent tier.
  assertEquals(isPitchCampaignAction("draft_pitch"), false);
  assertEquals(isPitchCampaignAction("list_tracks"), false);
});

Deno.test("chicagoDayStartIso returns an instant at or before now", () => {
  const now = new Date("2026-07-18T15:30:00Z");
  const start = chicagoDayStartIso(now);
  assert(start <= now.toISOString());
  // CT is UTC-5/-6, so 15:30Z is the same calendar day in Chicago; day start
  // must land on that day's local midnight, i.e. 05:00Z or 06:00Z.
  assert(start.startsWith("2026-07-18T0"), `unexpected day start: ${start}`);
});

Deno.test("evaluateCampaignConfig flags every missing piece", async () => {
  const sb = stubClient({
    tracks: [{ id: "t1", name: "Designed For Me", short_pitch: null, track_categories: [] }],
    smart_links: [],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", null);
  assert(cfg);
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing.sort(), ["category", "short_pitch", "smart_link"]);
});

Deno.test("evaluateCampaignConfig is ready only when all three are present", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Designed For Me",
      short_pitch: "A late-night control record.",
      track_categories: [{ category_id: "c1" }],
    }],
    smart_links: [{ id: "l1", slug: "dfm", is_active: true }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assert(cfg);
  assertEquals(cfg!.ready, true);
  assertEquals(cfg!.missing, []);
  assertEquals(cfg!.smart_link_url, "https://links.fendifrost.com/dfm");
});

Deno.test("an inactive smart link does not satisfy the guardrail", async () => {
  const sb = stubClient({
    tracks: [{
      id: "t1",
      name: "Designed For Me",
      short_pitch: "copy",
      track_categories: [{ category_id: "c1" }],
    }],
    smart_links: [{ id: "l1", slug: "dfm", is_active: false }],
  });
  const cfg = await evaluateCampaignConfig(sb, "t1", "l1");
  assertEquals(cfg!.ready, false);
  assertEquals(cfg!.missing, ["smart_link"]);
});

Deno.test("activeCampaignTrackNames lowercases and skips blanks", async () => {
  const sb = stubClient({
    pitch_campaigns: [
      { tracks: { name: "Designed For Me" } },
      { tracks: { name: "  Meditate  " } },
      { tracks: null },
    ],
  });
  const names = await activeCampaignTrackNames(sb);
  assertEquals(names.size, 2);
  assert(names.has("designed for me"));
  assert(names.has("meditate"));
});

Deno.test("assertTrackHasActiveCampaign rejects an un-campaigned song", async () => {
  const sb = stubClient({ pitch_campaigns: [] });
  await assertRejects(
    () => assertTrackHasActiveCampaign(sb, { trackId: "t1" }),
    Error,
    "No active pitch campaign",
  );
});

Deno.test("assertTrackHasActiveCampaign passes a campaigned song by track_id", async () => {
  const sb = stubClient({
    pitch_campaigns: [{ id: "c1", tracks: { name: "Designed For Me" } }],
  });
  const result = await assertTrackHasActiveCampaign(sb, { trackId: "t1" });
  assertEquals(result.campaign_id, "c1");
});

Deno.test("assertTrackHasActiveCampaign requires track_id", async () => {
  const sb = stubClient({ pitch_campaigns: [] });
  await assertRejects(
    () => assertTrackHasActiveCampaign(sb, {}),
    Error,
    "track_id is required",
  );
});

Deno.test("create_campaign always inserts draft and rejects paused/ended/active", async () => {
  const tables: Record<string, unknown[]> = {
    pitch_campaigns: [],
    tracks: [{
      id: "t1",
      name: "Meditate",
      short_pitch: "copy",
      track_categories: [{ category_id: "c1" }],
    }],
    smart_links: [{ id: "l1", slug: "meditate", is_active: true }],
    _lastInsert: [],
  };
  const sb = stubClient(tables);

  for (const bad of ["paused", "ended", "active"]) {
    const r = await runPitchCampaignAction("create_campaign", {
      track_id: "t1",
      smart_link_id: "l1",
      status: bad,
    }, sb);
    assertEquals(r.status, 400);
  }

  const ok = await runPitchCampaignAction("create_campaign", {
    track_id: "t1",
    smart_link_id: "l1",
  }, sb);
  assertEquals(ok.status, 200);
  assertEquals((tables._lastInsert[0] as { status: string }).status, "draft");
});

Deno.test("assertSendCampaignIdentity requires active live campaign evidence", async () => {
  const sb = stubClient({
    pitch_campaigns: [{
      id: "c1",
      track_id: "t1",
      status: "draft",
      authority_kind: "live",
      song_dna_version_id: null,
      fendi_activation_approved_at: null,
      configuration_snapshot: {},
    }],
  });
  await assertRejects(
    () => assertSendCampaignIdentity(sb, { trackId: "t1", campaignId: "c1" }),
    Error,
    "not active",
  );
});

Deno.test("activation rejects caller-supplied approver without admin actor", async () => {
  const sb = stubClient({
    pitch_campaigns: [{
      id: "c1",
      track_id: "t1",
      smart_link_id: "l1",
      status: "draft",
      started_at: null,
      pitch_copy: "copy",
      song_dna_version_id: "dna1",
      fendi_activation_approved_by: null,
      fendi_activation_approved_at: null,
      authority_kind: "live",
    }],
    tracks: [{
      id: "t1",
      name: "Meditate",
      short_pitch: "copy",
      track_categories: [{ category_id: "c1" }],
    }],
    smart_links: [{ id: "l1", slug: "m", is_active: true }],
    song_dna_versions: [{
      id: "dna1",
      track_id: "t1",
      approval_state: "approved",
      version_number: 1,
      primary_genre: "rap",
      approved_lanes: [],
      excluded_lanes: [],
    }],
  });
  const spoof = await runPitchCampaignAction(
    "update_campaign",
    {
      campaign_id: "c1",
      status: "active",
      song_dna_version_id: "dna1",
      fendi_activation_approved_by: "I am Fendi I swear",
    },
    sb,
    null,
  );
  assertEquals(spoof.status, 401);
  assertEquals(String((spoof.data as { error?: string }).error).includes("JWT"), true);
});
