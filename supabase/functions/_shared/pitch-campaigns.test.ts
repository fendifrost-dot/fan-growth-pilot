// Deno tests for the Pitch Portal campaign guardrail.
// Run: deno test supabase/functions/_shared/pitch-campaigns.test.ts
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeCampaignTrackNames,
  assertTrackHasActiveCampaign,
  chicagoDayStartIso,
  evaluateCampaignConfig,
  isPitchCampaignAction,
} from "./pitch-campaigns.ts";

// Minimal stub of the PostgREST builder surface these helpers actually touch.
// Each table maps to the rows a .select() should resolve to.
// deno-lint-ignore no-explicit-any
function stubClient(tables: Record<string, any[]>): any {
  const builder = (rows: unknown[]) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      not: () => chain,
      order: () => chain,
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
