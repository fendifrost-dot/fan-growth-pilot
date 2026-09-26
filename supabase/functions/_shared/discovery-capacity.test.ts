/**
 * Discovery capacity (Fix 1): split funnel, all-channel draft denominator, explicit
 * measured / no_data / query_failed / measured_zero states, configurable research budget.
 */
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assembleDiscoveryCapacityPlan,
  buildDiscoveryCapacityPlan,
  classifyFunnelStage,
  dailyTargetFromPlan,
  funnelWindow,
  measureVerifiedToDraft,
} from "./discovery-capacity.ts";

type Row = Record<string, unknown>;

/** Minimal PostgREST stub: eq/in filters, range filters ignored, per-table error injection. */
function stubSb(tables: Record<string, Row[]>, failTables: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const apply = () =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([k, v]) =>
            Array.isArray(v) ? v.map(String).includes(String(r[k])) : String(r[k]) === String(v)
          )
        );
      const result = () =>
        failTables[table]
          ? { data: null, error: { message: failTables[table] } }
          : { data: apply(), error: null };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.push([k, v]), chain),
        in: (k: string, v: unknown[]) => (filters.push([k, v]), chain),
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          const r = result();
          return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error });
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(result())),
      };
      return chain;
    },
  };
  return sb;
}

const NOW = new Date("2026-09-20T15:00:00Z");

function run(raw: number, verified: number, station = "playlist_tranche_final"): Row {
  return {
    id: crypto.randomUUID(),
    station_id: station,
    status: "completed",
    raw_discoveries: raw,
    verified_targets: verified,
    completed_at: "2026-09-19T20:00:00Z",
  };
}

const BASE_TABLES = (): Record<string, Row[]> => ({
  ops_settings: [],
  daily_ops_station_runs: [],
  playlist_targets: [],
  agh_handoff_records: [],
  outreach_drafts: [],
});

Deno.test("capacity: normal measured raw→verified rate sizes the estimate; budget is separate", async () => {
  const t = BASE_TABLES();
  t.daily_ops_station_runs = [run(100, 35), run(73, 25)]; // 60 / 173
  const plan = await buildDiscoveryCapacityPlan(stubSb(t), 2, { now: NOW });
  const dt = dailyTargetFromPlan(plan);

  assertEquals(dt.measurement_status, "measured");
  assertEquals(dt.fallback_used, false);
  assertEquals(dt.numerator, 60);
  assertEquals(dt.denominator, 173);
  assertEquals(dt.sample_size, 2);
  assertEquals(dt.daily_raw_requirement_basis, "measured");
  assertEquals(plan.objective_verified_total, 60);
  // ceil(60 / (60/173)) = 173 — the 2026-09-08 number, from the right funnel stage.
  assertEquals(dt.daily_raw_requirement, 173);
  // Research budget is configured, not derived: default 90/song × 2 songs.
  assertEquals(dt.effective_raw_target, 180);
  assertEquals(dt.research_budget_raw_total, 180);
  assertEquals(dt.research_budget_source, "default");
  assertEquals(dt.research_budget_covers_estimate, true);
  assertEquals(dt.effective_verified_target, 60);
  const w = dt.window as { lookback_days: number; since: string; until: string };
  assertEquals(w.lookback_days, 7);
  assertEquals(w.until, NOW.toISOString());
});

Deno.test("capacity: missing data → no_data with fallback_used=true (estimate labeled fallback, budget unchanged)", async () => {
  const t = BASE_TABLES();
  // A run that never reported raw_discoveries is not a sample.
  t.daily_ops_station_runs = [run(0, 12)];
  const plan = await buildDiscoveryCapacityPlan(stubSb(t), 2, { now: NOW });
  const dt = dailyTargetFromPlan(plan);

  assertEquals(dt.measurement_status, "no_data");
  assertEquals(dt.fallback_used, true);
  assertEquals(dt.fallback_rate, 0.05);
  assertEquals(dt.conversion_rate, null);
  assertEquals(dt.sample_size, 0);
  assertEquals(dt.daily_raw_requirement_basis, "fallback");
  assertEquals(dt.daily_raw_requirement, 1200);
  // The 1200 fallback estimate never becomes the authorized research budget.
  assertEquals(dt.effective_raw_target, 180);
  assertEquals(dt.research_budget_covers_estimate, false);
  assert((dt.warnings as string[]).some((w) => w.includes("fallback rate")));
});

Deno.test("capacity: query failure → query_failed flag + error, never a 0 that feeds the rate", async () => {
  const t = BASE_TABLES();
  t.daily_ops_station_runs = [run(100, 35)];
  const plan = await buildDiscoveryCapacityPlan(
    stubSb(t, { daily_ops_station_runs: "relation does not exist" }),
    2,
    { now: NOW },
  );
  const dt = dailyTargetFromPlan(plan);

  assertEquals(dt.measurement_status, "query_failed");
  assertEquals(dt.fallback_used, false);
  assertEquals(dt.conversion_rate, null);
  assertEquals(dt.numerator, null);
  assertEquals(dt.denominator, null);
  assertEquals(dt.daily_raw_requirement, null);
  assertEquals(dt.daily_raw_requirement_basis, "query_failed");
  assert(String(dt.measurement_error).includes("relation does not exist"));
  assertEquals(dt.effective_raw_target, 180);
  assert((dt.warnings as string[]).some((w) => w.includes("query failed")));
});

Deno.test("capacity: genuine zero yield → measured_zero (no fallback, no estimate)", async () => {
  const t = BASE_TABLES();
  t.daily_ops_station_runs = [run(80, 0), run(40, 0)];
  const plan = await buildDiscoveryCapacityPlan(stubSb(t), 2, { now: NOW });
  const dt = dailyTargetFromPlan(plan);

  assertEquals(dt.measurement_status, "measured_zero");
  assertEquals(dt.fallback_used, false);
  assertEquals(dt.conversion_rate, 0);
  assertEquals(dt.numerator, 0);
  assertEquals(dt.denominator, 120);
  assertEquals(dt.sample_size, 2);
  assertEquals(dt.daily_raw_requirement, null);
  assertEquals(dt.daily_raw_requirement_basis, "measured_zero");
  assert((dt.warnings as string[]).some((w) => w.includes("not converting")));
});

Deno.test("capacity: the four states produce visibly different daily_target responses", async () => {
  const mk = async (runs: Row[], fail?: string) => {
    const t = BASE_TABLES();
    t.daily_ops_station_runs = runs;
    const plan = await buildDiscoveryCapacityPlan(
      stubSb(t, fail ? { daily_ops_station_runs: fail } : {}),
      2,
      { now: NOW },
    );
    const dt = dailyTargetFromPlan(plan);
    return JSON.stringify([
      dt.measurement_status,
      dt.fallback_used,
      dt.conversion_rate,
      dt.daily_raw_requirement,
      dt.daily_raw_requirement_basis,
    ]);
  };
  const measured = await mk([run(100, 35)]);
  const noData = await mk([]);
  const failed = await mk([run(100, 35)], "boom");
  const zero = await mk([run(100, 0)]);
  const all = new Set([measured, noData, failed, zero]);
  assertEquals(all.size, 4);
});

Deno.test("capacity: raw→verified cohort ignores non-playlist stations and caps verified at raw", async () => {
  const t = BASE_TABLES();
  t.daily_ops_station_runs = [
    run(10, 50), // agent over-reported verified: capped to 10
    run(90, 20),
    run(500, 0, "sync_batch_ready"), // not a playlist station → excluded by station filter
  ];
  const plan = await buildDiscoveryCapacityPlan(stubSb(t), 1, { now: NOW });
  const r2v = plan.funnel.raw_to_verified;
  assertEquals(r2v.numerator, 30);
  assertEquals(r2v.denominator, 100);
  assertEquals(r2v.rate, 0.3);
});

Deno.test("capacity: verified→draft counts web-form + IG manual packets, not only outreach_drafts", async () => {
  const t = BASE_TABLES();
  t.playlist_targets = [
    { playlist_id: "p-email", verification_status: "auto_verified", path_verified: true, contact_method: "email" },
    { playlist_id: "p-form-1", verification_status: "auto_verified", path_verified: true, contact_method: "web_form" },
    { playlist_id: "p-form-2", verification_status: "manually_verified", path_verified: true, submission_method: "web_form" },
    { playlist_id: "p-ig", verification_status: "auto_verified", path_verified: true, contact_method: "instagram_dm" },
  ];
  t.outreach_drafts = [{ playlist_id: "p-email" }];
  t.agh_handoff_records = [
    { playlist_target_id: "p-email", submission_channel: "email" },
    { playlist_target_id: "p-form-1", submission_channel: "web_form" },
    { playlist_target_id: "p-ig", submission_channel: "instagram_dm" },
  ];
  const m = await measureVerifiedToDraft(stubSb(t), funnelWindow(7, NOW));
  assertEquals(m.status, "measured");
  assertEquals(m.numerator, 3);
  assertEquals(m.denominator, 4);
  assertEquals(m.rate, 0.75);
  assertEquals(m.by_channel?.web_form, { verified: 2, drafted: 1 });
  assertEquals(m.by_channel?.instagram_dm, { verified: 1, drafted: 1 });

  // The old email-only numerator would have reported 1/4 on the same cohort.
  assertNotEquals(m.rate, 0.25);
});

Deno.test("capacity: verified→draft query failure mid-chunk is query_failed, not a partial count", async () => {
  const t = BASE_TABLES();
  t.playlist_targets = [
    { playlist_id: "p1", verification_status: "auto_verified", path_verified: true, contact_method: "web_form" },
  ];
  const m = await measureVerifiedToDraft(
    stubSb(t, { agh_handoff_records: "timeout" }),
    funnelWindow(7, NOW),
  );
  assertEquals(m.status, "query_failed");
  assertEquals(m.rate, null);
  assert(String(m.error).includes("timeout"));
});

Deno.test("capacity: verified→draft never sizes the raw target", () => {
  const window = funnelWindow(7, NOW);
  const settingsLoad = {
    settings: {},
    status: "loaded" as const,
    error: null,
    explicit_keys: [],
  };
  const r2v = classifyFunnelStage({
    stage: "raw_to_verified",
    window,
    source: "t",
    numerator: 50,
    denominator: 100,
    sampleSize: 3,
  });
  const lowV2D = classifyFunnelStage({
    stage: "verified_to_draft",
    window,
    source: "t",
    numerator: 1,
    denominator: 100,
    sampleSize: 100,
  });
  const highV2D = classifyFunnelStage({
    stage: "verified_to_draft",
    window,
    source: "t",
    numerator: 100,
    denominator: 100,
    sampleSize: 100,
  });
  const a = assembleDiscoveryCapacityPlan({ activePitchingSongs: 2, settingsLoad, rawToVerified: r2v, verifiedToDraft: lowV2D });
  const b = assembleDiscoveryCapacityPlan({ activePitchingSongs: 2, settingsLoad, rawToVerified: r2v, verifiedToDraft: highV2D });
  assertEquals(a.daily_raw_requirement, 120);
  assertEquals(a.daily_raw_requirement, b.daily_raw_requirement);
  assertEquals(a.effective_raw_target, b.effective_raw_target);
});

Deno.test("capacity: research budget is configurable via ops_settings and reported as such", async () => {
  const t = BASE_TABLES();
  t.ops_settings = [{
    setting_key: "discovery_capacity",
    setting_value: { research_budget_raw_per_song: 120, target_verified_per_song_per_day: 30 },
  }];
  t.daily_ops_station_runs = [run(100, 35)];
  const plan = await buildDiscoveryCapacityPlan(stubSb(t), 2, { now: NOW });
  assertEquals(plan.research_budget_raw_per_song, 120);
  assertEquals(plan.research_budget_raw_total, 240);
  assertEquals(plan.research_budget_source, "ops_settings");
  assertEquals(plan.effective_raw_target, 240);
  // Objective untouched.
  assertEquals(plan.objective_verified_total, 60);
});

Deno.test("capacity: ops_settings query failure is flagged (defaults in use), not silent", async () => {
  const t = BASE_TABLES();
  t.daily_ops_station_runs = [run(100, 35)];
  const plan = await buildDiscoveryCapacityPlan(stubSb(t, { ops_settings: "permission denied" }), 2, {
    now: NOW,
  });
  assertEquals(plan.settings_status, "query_failed");
  assert(plan.warnings.some((w) => w.includes("ops_settings")));
  assertEquals(plan.research_budget_raw_total, 180);
});
