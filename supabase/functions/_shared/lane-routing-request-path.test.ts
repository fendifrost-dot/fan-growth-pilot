/**
 * Request-path lane routing — AGH routing completeness.
 * Proves approved discovery profiles initialize SWEEP_LANE_GENRE, structured
 * underscored lane slugs resolve without free-text fallback, unknown lanes fail
 * closed, and free text cannot override an explicit unresolvable lane.
 *
 * Run: deno test --allow-env --allow-read supabase/functions/_shared/lane-routing-request-path.test.ts
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  genreFromLaneSlug,
  setSweepLaneRoutingFromProfiles,
  SWEEP_LANE_GENRE,
  sweepLaneTextGenre,
} from "./playlist-lanes.ts";
import { targetGenre } from "./placement-match.ts";
import { profilesToSweepBuckets, type DiscoveryProfile } from "./discovery-profiles.ts";
import { ensureSweepLaneRouting } from "./playlist-agent-run.ts";

function profile(
  partial: Partial<DiscoveryProfile> & Pick<DiscoveryProfile, "profile_key" | "genre_family" | "approved_lanes">,
): DiscoveryProfile {
  return {
    id: partial.id ?? `id-${partial.profile_key}`,
    profile_key: partial.profile_key,
    label: partial.label ?? partial.profile_key,
    is_active: partial.is_active ?? true,
    approval_status: partial.approval_status ?? "approved",
    genre_family: partial.genre_family,
    included_search_terms: partial.included_search_terms ?? [],
    excluded_search_terms: partial.excluded_search_terms ?? [],
    reference_artists: partial.reference_artists ?? [],
    compatible_target_category_slugs: partial.compatible_target_category_slugs ?? [],
    search_weight: partial.search_weight ?? 1,
    approved_lanes: partial.approved_lanes,
    excluded_lanes: partial.excluded_lanes ?? [],
    matching_expression: partial.matching_expression ?? null,
    allocation_share: partial.allocation_share ?? null,
  };
}

Deno.test("approved discovery profiles initialize request-path lane routing", () => {
  setSweepLaneRoutingFromProfiles({});
  assertEquals(Object.keys(SWEEP_LANE_GENRE).length, 0);

  const buckets = profilesToSweepBuckets([
    profile({
      profile_key: "house_ops",
      genre_family: "house",
      approved_lanes: ["house_club", "deep_house_groove"],
    }),
    profile({
      profile_key: "rap_ops",
      genre_family: "rap",
      approved_lanes: ["rap_general", "rap_trap_hype"],
    }),
  ]);
  setSweepLaneRoutingFromProfiles(buckets.laneGenre, buckets.laneBlockPatterns);

  assertEquals(SWEEP_LANE_GENRE["house_club"], "house");
  assertEquals(SWEEP_LANE_GENRE["deep_house_groove"], "house");
  assertEquals(SWEEP_LANE_GENRE["rap_general"], "rap");
  assertEquals(SWEEP_LANE_GENRE["rap_trap_hype"], "rap");
  assertEquals(targetGenre({ lane: "house_club", playlist_name: "Untitled" }), "house");
  assertEquals(targetGenre({ lane: "rap_trap_hype", playlist_name: "Untitled" }), "rap");
});

Deno.test("ensureSweepLaneRouting loads approved profiles into SWEEP_LANE_GENRE", async () => {
  setSweepLaneRoutingFromProfiles({});
  assertEquals(Object.keys(SWEEP_LANE_GENRE).length, 0);

  const allRows = [
    profile({
      profile_key: "house_ops",
      genre_family: "house",
      approved_lanes: ["house_club", "deep_house_groove"],
      approval_status: "approved",
    }),
    profile({
      profile_key: "rap_ops",
      genre_family: "rap",
      approved_lanes: ["rap_general", "rap_trap_hype"],
      approval_status: "approved",
    }),
    profile({
      profile_key: "pending_noise",
      genre_family: "house",
      approved_lanes: ["should_not_appear"],
      approval_status: "pending",
    }),
  ];

  const sb = {
    from(_table: string) {
      let rows = [...allRows];
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (col: string, val: unknown) => {
          if (col === "is_active") rows = rows.filter((r) => r.is_active === val);
          if (col === "approval_status") rows = rows.filter((r) => r.approval_status === val);
          return api;
        },
        order: () => api,
        // Lazy thenable — evaluate filters at await-time, not at from()-time.
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return api;
    },
  };

  await ensureSweepLaneRouting(sb as never);
  assertEquals(SWEEP_LANE_GENRE["house_club"], "house");
  assertEquals(SWEEP_LANE_GENRE["deep_house_groove"], "house");
  assertEquals(SWEEP_LANE_GENRE["rap_general"], "rap");
  assertEquals(SWEEP_LANE_GENRE["rap_trap_hype"], "rap");
  assertEquals(SWEEP_LANE_GENRE["should_not_appear"], undefined);
});

Deno.test("structured underscored lane slugs resolve without the profile map", () => {
  setSweepLaneRoutingFromProfiles({});
  assertEquals(genreFromLaneSlug("house_club"), "house");
  assertEquals(genreFromLaneSlug("deep_house_groove"), "house");
  assertEquals(genreFromLaneSlug("rap_general"), "rap");
  assertEquals(genreFromLaneSlug("rap_trap_hype"), "rap");
  assertEquals(targetGenre({ lane: "house_club", playlist_name: "Untitled" }), "house");
  assertEquals(targetGenre({ lane: "deep_house_groove", playlist_name: "Untitled" }), "house");
  assertEquals(targetGenre({ lane: "rap_general", playlist_name: "Untitled" }), "rap");
  assertEquals(targetGenre({ lane: "rap_trap_hype", playlist_name: "Untitled" }), "rap");
});

Deno.test("unknown/null lanes fail closed (do not invent a genre)", () => {
  setSweepLaneRoutingFromProfiles({});
  assertEquals(genreFromLaneSlug(null), null);
  assertEquals(genreFromLaneSlug(""), null);
  assertEquals(genreFromLaneSlug("ambient_focus"), null);
  assertEquals(targetGenre({ lane: "ambient_focus", playlist_name: "Deep House Grooves" }), null);
  assertEquals(targetGenre({ lane: null, playlist_name: "Chill Vibes" }), null);
});

Deno.test("legacy free-text matching cannot override an explicit unresolvable lane", () => {
  setSweepLaneRoutingFromProfiles({});
  assertEquals(
    targetGenre({ lane: "unknown_lane_xyz", playlist_name: "Soulful Deep House Club" }),
    null,
  );
  assertEquals(targetGenre({ playlist_name: "Soulful Deep House Club" }), "house");
  assertEquals(sweepLaneTextGenre("house_club"), null);
});

Deno.test("no production song-title literals in lane routing modules", () => {
  const lanes = Deno.readTextFileSync(new URL("./playlist-lanes.ts", import.meta.url));
  const match = Deno.readTextFileSync(new URL("./placement-match.ts", import.meta.url));
  const agent = Deno.readTextFileSync(new URL("./playlist-agent-run.ts", import.meta.url));
  // Strip block/line comments — incident writeups may name songs; routing code must not.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const [name, src] of [
    ["playlist-lanes", lanes],
    ["placement-match", match],
    ["playlist-agent-run", agent],
  ] as const) {
    const code = stripComments(src);
    assert(!/\bMeditate\b/i.test(code), `${name} must not hard-code Meditate as routing logic`);
    assert(!/\bDesigned For Me\b/i.test(code), `${name} must not hard-code Designed For Me as routing logic`);
    assert(!/TRACK_IDS|song_title_allowlist/i.test(code), `${name} must not carry song allowlists`);
  }
  assert(agent.includes("ensureSweepLaneRouting"), "playlist-agent-run must call ensureSweepLaneRouting");
  assert(
    agent.includes("setSweepLaneRoutingFromProfiles"),
    "playlist-agent-run must wire setSweepLaneRoutingFromProfiles",
  );
});
