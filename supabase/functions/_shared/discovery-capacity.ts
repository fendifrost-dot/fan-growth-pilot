/**
 * Discovery capacity planning from ops_settings (editable) — not code constants.
 *
 * OBJECTIVE — how many verified targets we want per day
 * (target_verified_per_song_per_day × active songs; default 30/song).
 *
 * Raw research is UNCAPPED: there is no research budget or ceiling on raw passes. The
 * agent keeps researching until the verified objective is met (or sources saturate).
 * `effective_raw_target` is only the measured estimate of how many raw passes that will
 * take — guidance, never a limit.
 *
 * The funnel is measured as two independent stages so an agent can audit the number:
 *
 *   raw → verified   (discovery + route-finding yield) — station-run metrics
 *   verified → draft (compose + persist yield, ALL channels) — targets → handoff records
 *
 * Only raw → verified is used to estimate raw demand (`daily_raw_requirement`).
 *
 * Every measurement carries an explicit status so "no data", "query failed" and
 * "measured zero" can never collapse into the same silent fallback number:
 *   measured       rows exist, rate > 0
 *   measured_zero  rows exist, numerator is genuinely 0
 *   no_data        no rows in the window (fallback rate is used, fallback_used=true)
 *   query_failed   the query itself errored (no rate, no estimate, error surfaced)
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { chicagoBusinessDate } from "./chicago-time.ts";

export const PLAYLIST_STATION_IDS = [
  "playlist_discovery_begin",
  "playlist_tranche_first",
  "playlist_tranche_final",
] as const;

/** Verified statuses (kept local to avoid pulling verify-target's email deps into this module). */
const VERIFIED_TARGET_STATUSES = ["auto_verified", "manually_verified"] as const;

export const DISCOVERY_CAPACITY_DEFAULTS = {
  interim_raw_floor_per_song: 45,
  interim_verified_floor_per_song: 30,
  target_verified_per_song_per_day: 30,
  trailing_conversion_lookback_days: 7,
  /** Fallback raw→verified rate — only ever applied when status is `no_data`. */
  min_conversion_rate: 0.05,
} as const;

export type MeasurementStatus = "measured" | "measured_zero" | "no_data" | "query_failed";

export type FunnelWindow = {
  lookback_days: number;
  since: string;
  until: string;
};

export type FunnelStageMeasurement = {
  stage: "raw_to_verified" | "verified_to_draft";
  status: MeasurementStatus;
  /** null unless status is measured / measured_zero. */
  rate: number | null;
  numerator: number | null;
  denominator: number | null;
  /** Rows in the cohort (station runs for raw→verified, targets for verified→draft). */
  sample_size: number | null;
  window: FunnelWindow;
  source: string;
  error: string | null;
  /** Optional per-channel breakdown (verified→draft only). */
  by_channel?: Record<string, { verified: number; drafted: number }>;
};

export type RawEstimateBasis = "measured" | "fallback" | "measured_zero" | "query_failed";

export type DiscoveryCapacityPlan = {
  active_pitching_songs: number;
  target_verified_per_song_per_day: number;
  /** Output objective: verified targets wanted today (per-song objective × songs). */
  objective_verified_total: number;
  /** Advisory raw-pass estimate from raw→verified only. null when not estimable. */
  daily_raw_requirement: number | null;
  daily_raw_requirement_basis: RawEstimateBasis;
  /** Always false: raw research has no ceiling; research continues until the objective is met. */
  raw_research_capped: false;
  interim_raw_floor_total: number;
  interim_verified_floor_total: number;
  /** Estimated raw passes to reach the objective (= daily_raw_requirement). Guidance, not a cap. */
  effective_raw_target: number | null;
  effective_verified_target: number;
  lookback_days: number;
  fallback_used: boolean;
  fallback_rate: number;
  /** Status of the raw→verified measurement that sizes the estimate. */
  measurement_status: MeasurementStatus;
  funnel: {
    raw_to_verified: FunnelStageMeasurement;
    verified_to_draft: FunnelStageMeasurement;
  };
  settings_status: "loaded" | "defaults_no_row" | "query_failed";
  settings_error: string | null;
  warnings: string[];
  settings: Record<string, unknown>;
};

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Legacy pure helper: ceil((perSong × songs) ÷ max(rate, floor)).
 * NOT used by buildDiscoveryCapacityPlan — kept for callers/tests that want the
 * raw formula. buildDiscoveryCapacityPlan never feeds it a silent fallback.
 */
export function computeDailyRawRequirement(opts: {
  activePitchingSongs: number;
  targetVerifiedPerSong?: number;
  conversionRate: number;
  minConversionRate?: number;
}): number {
  const songs = Math.max(0, Math.floor(opts.activePitchingSongs));
  const perSong = opts.targetVerifiedPerSong ?? 30;
  const minRate = opts.minConversionRate ?? 0.05;
  const rate = Math.max(minRate, opts.conversionRate > 0 ? opts.conversionRate : minRate);
  if (songs === 0) return 0;
  return Math.ceil((perSong * songs) / rate);
}

export type DiscoveryCapacitySettingsLoad = {
  settings: Record<string, unknown>;
  status: "loaded" | "defaults_no_row" | "query_failed";
  error: string | null;
};

export async function loadDiscoveryCapacitySettingsDetailed(
  sb: SupabaseClient,
): Promise<DiscoveryCapacitySettingsLoad> {
  const { data, error } = await sb
    .from("ops_settings")
    .select("setting_value")
    .eq("setting_key", "discovery_capacity")
    .maybeSingle();
  const v = (error ? {} : (data?.setting_value ?? {})) as Record<string, unknown>;
  const d = DISCOVERY_CAPACITY_DEFAULTS;
  const settings: Record<string, unknown> = {
    interim_raw_floor_per_song: num(v.interim_raw_floor_per_song, d.interim_raw_floor_per_song),
    interim_verified_floor_per_song: num(
      v.interim_verified_floor_per_song,
      d.interim_verified_floor_per_song,
    ),
    target_verified_per_song_per_day: num(
      v.target_verified_per_song_per_day,
      d.target_verified_per_song_per_day,
    ),
    trailing_conversion_lookback_days: num(
      v.trailing_conversion_lookback_days,
      d.trailing_conversion_lookback_days,
    ),
    min_conversion_rate: num(v.min_conversion_rate, d.min_conversion_rate),
  };
  return {
    settings,
    status: error ? "query_failed" : data ? "loaded" : "defaults_no_row",
    error: error ? String(error.message) : null,
  };
}

/** Back-compat wrapper — settings only. */
export async function loadDiscoveryCapacitySettings(
  sb: SupabaseClient,
): Promise<Record<string, unknown>> {
  return (await loadDiscoveryCapacitySettingsDetailed(sb)).settings;
}

export function funnelWindow(lookbackDays: number, now: Date = new Date()): FunnelWindow {
  const days = Math.max(1, Math.floor(lookbackDays));
  const since = new Date(now.getTime());
  since.setUTCDate(since.getUTCDate() - days);
  return { lookback_days: days, since: since.toISOString(), until: now.toISOString() };
}

/**
 * Pure classifier for a funnel stage. A query error ALWAYS wins and never produces a
 * rate; an empty cohort is `no_data`; a non-empty cohort with zero yield is
 * `measured_zero` (a real signal, not a fallback trigger).
 */
export function classifyFunnelStage(input: {
  stage: FunnelStageMeasurement["stage"];
  window: FunnelWindow;
  source: string;
  numerator: number;
  denominator: number;
  sampleSize: number;
  error?: string | null;
}): FunnelStageMeasurement {
  const base = {
    stage: input.stage,
    window: input.window,
    source: input.source,
  };
  if (input.error) {
    return {
      ...base,
      status: "query_failed",
      rate: null,
      numerator: null,
      denominator: null,
      sample_size: null,
      error: input.error,
    };
  }
  if (input.sampleSize <= 0 || input.denominator <= 0) {
    return {
      ...base,
      status: "no_data",
      rate: null,
      numerator: input.numerator,
      denominator: input.denominator,
      sample_size: input.sampleSize,
      error: null,
    };
  }
  const rate = Math.min(1, Math.max(0, input.numerator / input.denominator));
  return {
    ...base,
    status: rate > 0 ? "measured" : "measured_zero",
    rate,
    numerator: input.numerator,
    denominator: input.denominator,
    sample_size: input.sampleSize,
    error: null,
  };
}

/**
 * raw → verified yield from Claude playlist station runs in the window.
 * Numerator and denominator come from the SAME run rows (same cohort by construction):
 *   Σ min(verified_targets, raw_discoveries) ÷ Σ raw_discoveries, runs with raw > 0.
 * Runs that reported no raw count are excluded (they would inflate the rate).
 */
export async function measureRawToVerified(
  sb: SupabaseClient,
  window: FunnelWindow,
): Promise<FunnelStageMeasurement> {
  const source =
    "daily_ops_station_runs (playlist stations, status completed|partial, completed_at in window)";
  const { data, error } = await sb
    .from("daily_ops_station_runs")
    .select("id, station_id, status, raw_discoveries, verified_targets, completed_at")
    .in("station_id", [...PLAYLIST_STATION_IDS])
    .in("status", ["completed", "partial"])
    .gte("completed_at", window.since)
    .lte("completed_at", window.until);
  if (error) {
    return classifyFunnelStage({
      stage: "raw_to_verified",
      window,
      source,
      numerator: 0,
      denominator: 0,
      sampleSize: 0,
      error: `station_runs_query_failed:${error.message}`,
    });
  }
  let numerator = 0;
  let denominator = 0;
  let sample = 0;
  for (const r of data ?? []) {
    const raw = Math.max(0, Math.floor(Number(r.raw_discoveries) || 0));
    if (raw <= 0) continue;
    const verified = Math.max(0, Math.floor(Number(r.verified_targets) || 0));
    numerator += Math.min(verified, raw);
    denominator += raw;
    sample++;
  }
  return classifyFunnelStage({
    stage: "raw_to_verified",
    window,
    source,
    numerator,
    denominator,
    sampleSize: sample,
  });
}

/** Pure helper for tests — verified→draft over one cohort without I/O. */
export function verifiedToDraftRate(verifiedIds: string[], draftedIds: string[]): number {
  const verified = new Set(verifiedIds.filter(Boolean));
  if (verified.size === 0) return 0;
  const drafted = new Set(draftedIds.filter((id) => verified.has(id)));
  return Math.min(1, drafted.size / verified.size);
}

function targetChannel(row: Record<string, unknown>): string {
  for (const k of ["contact_method", "submission_method"]) {
    const c = String(row[k] ?? "").trim().toLowerCase();
    if (c === "email" || c === "web_form" || c === "instagram_dm") return c;
  }
  return "unknown";
}

/**
 * verified → draft yield across ALL channels.
 *
 * Cohort: path-verified playlist targets CREATED in the window. (The old query keyed on
 * last_verified_at, which re-verification sweeps refresh on old catalog rows — pulling
 * hundreds of long-since-drafted, mostly form-only targets into the denominator while the
 * numerator only looked for outreach_drafts created in the window.)
 *
 * Drafted = the target has ≥1 agh_handoff_records row (email drafts AND web-form / IG-DM
 * manual packets) or ≥1 outreach_drafts row. Any query error → query_failed; partial
 * results are never used.
 */
export async function measureVerifiedToDraft(
  sb: SupabaseClient,
  window: FunnelWindow,
): Promise<FunnelStageMeasurement> {
  const source =
    "playlist_targets (path-verified, created_at in window) → agh_handoff_records ∪ outreach_drafts";
  const fail = (msg: string) =>
    classifyFunnelStage({
      stage: "verified_to_draft",
      window,
      source,
      numerator: 0,
      denominator: 0,
      sampleSize: 0,
      error: msg,
    });

  const { data: targets, error: tErr } = await sb
    .from("playlist_targets")
    .select("playlist_id, contact_method, submission_method, created_at")
    .in("verification_status", [...VERIFIED_TARGET_STATUSES])
    .eq("path_verified", true)
    .gte("created_at", window.since)
    .lte("created_at", window.until);
  if (tErr) return fail(`verified_targets_query_failed:${tErr.message}`);

  const channelOf = new Map<string, string>();
  for (const t of targets ?? []) {
    const id = String(t.playlist_id ?? "").trim();
    if (id) channelOf.set(id, targetChannel(t as Record<string, unknown>));
  }
  const ids = [...channelOf.keys()];

  const drafted = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data: recs, error: rErr } = await sb
      .from("agh_handoff_records")
      .select("playlist_target_id")
      .in("playlist_target_id", chunk);
    if (rErr) return fail(`handoff_records_query_failed:${rErr.message}`);
    for (const r of recs ?? []) {
      if (r.playlist_target_id) drafted.add(String(r.playlist_target_id));
    }
    const { data: drafts, error: dErr } = await sb
      .from("outreach_drafts")
      .select("playlist_id")
      .in("playlist_id", chunk);
    if (dErr) return fail(`outreach_drafts_query_failed:${dErr.message}`);
    for (const d of drafts ?? []) {
      if (d.playlist_id) drafted.add(String(d.playlist_id));
    }
  }

  const byChannel: Record<string, { verified: number; drafted: number }> = {};
  let numerator = 0;
  for (const [id, ch] of channelOf) {
    byChannel[ch] ??= { verified: 0, drafted: 0 };
    byChannel[ch].verified++;
    if (drafted.has(id)) {
      byChannel[ch].drafted++;
      numerator++;
    }
  }

  return {
    ...classifyFunnelStage({
      stage: "verified_to_draft",
      window,
      source,
      numerator,
      denominator: ids.length,
      sampleSize: ids.length,
    }),
    by_channel: byChannel,
  };
}

/**
 * Pure plan assembly — every branch of the raw estimate is explicit and visible.
 */
export function assembleDiscoveryCapacityPlan(input: {
  activePitchingSongs: number;
  settingsLoad: DiscoveryCapacitySettingsLoad;
  rawToVerified: FunnelStageMeasurement;
  verifiedToDraft: FunnelStageMeasurement;
}): DiscoveryCapacityPlan {
  const { settings } = input.settingsLoad;
  const d = DISCOVERY_CAPACITY_DEFAULTS;
  const songs = Math.max(0, Math.floor(input.activePitchingSongs));
  const perSong = num(settings.target_verified_per_song_per_day, d.target_verified_per_song_per_day);
  const fallbackRate = num(settings.min_conversion_rate, d.min_conversion_rate);
  const lookback = num(settings.trailing_conversion_lookback_days, d.trailing_conversion_lookback_days);
  const objective = Math.ceil(perSong * songs);

  const warnings: string[] = [];
  const r2v = input.rawToVerified;
  let estimate: number | null = null;
  let basis: RawEstimateBasis;
  let fallbackUsed = false;

  switch (r2v.status) {
    case "measured":
      basis = "measured";
      estimate = objective === 0 ? 0 : Math.ceil(objective / (r2v.rate as number));
      break;
    case "no_data":
      basis = "fallback";
      fallbackUsed = true;
      if (objective === 0) estimate = 0;
      else if (fallbackRate > 0) estimate = Math.ceil(objective / fallbackRate);
      warnings.push(
        `raw_to_verified: no station runs with raw_discoveries in the last ${r2v.window.lookback_days}d — estimate uses the configured fallback rate ${fallbackRate}, not a measurement`,
      );
      break;
    case "measured_zero":
      basis = "measured_zero";
      estimate = null;
      warnings.push(
        `raw_to_verified: ${r2v.denominator} raw discoveries over ${r2v.sample_size} runs produced 0 verified — research is not converting; no raw estimate is possible`,
      );
      break;
    case "query_failed":
    default:
      basis = "query_failed";
      estimate = null;
      warnings.push(`raw_to_verified: measurement query failed (${r2v.error}) — no estimate`);
      break;
  }

  if (input.verifiedToDraft.status === "query_failed") {
    warnings.push(`verified_to_draft: measurement query failed (${input.verifiedToDraft.error})`);
  }
  if (input.settingsLoad.status === "query_failed") {
    warnings.push(
      `ops_settings.discovery_capacity query failed (${input.settingsLoad.error}) — defaults in use`,
    );
  }

  const rawFloor = Math.ceil(num(settings.interim_raw_floor_per_song, d.interim_raw_floor_per_song) * songs);
  const verifiedFloor = Math.ceil(
    num(settings.interim_verified_floor_per_song, d.interim_verified_floor_per_song) * songs,
  );

  return {
    active_pitching_songs: songs,
    target_verified_per_song_per_day: perSong,
    objective_verified_total: objective,
    daily_raw_requirement: estimate,
    daily_raw_requirement_basis: basis,
    raw_research_capped: false,
    interim_raw_floor_total: rawFloor,
    interim_verified_floor_total: verifiedFloor,
    effective_raw_target: estimate,
    effective_verified_target: verifiedFloor,
    lookback_days: lookback,
    fallback_used: fallbackUsed,
    fallback_rate: fallbackRate,
    measurement_status: r2v.status,
    funnel: {
      raw_to_verified: r2v,
      verified_to_draft: input.verifiedToDraft,
    },
    settings_status: input.settingsLoad.status,
    settings_error: input.settingsLoad.error,
    warnings,
    settings,
  };
}

export async function buildDiscoveryCapacityPlan(
  sb: SupabaseClient,
  activePitchingSongs: number,
  opts: { now?: Date } = {},
): Promise<DiscoveryCapacityPlan> {
  const settingsLoad = await loadDiscoveryCapacitySettingsDetailed(sb);
  const lookback = num(
    settingsLoad.settings.trailing_conversion_lookback_days,
    DISCOVERY_CAPACITY_DEFAULTS.trailing_conversion_lookback_days,
  );
  const window = funnelWindow(lookback, opts.now);
  const [rawToVerified, verifiedToDraft] = await Promise.all([
    measureRawToVerified(sb, window),
    measureVerifiedToDraft(sb, window),
  ]);
  return assembleDiscoveryCapacityPlan({
    activePitchingSongs,
    settingsLoad,
    rawToVerified,
    verifiedToDraft,
  });
}

/** Tool-facing projection of the plan for get_playlist_discovery_work.daily_target. */
export function dailyTargetFromPlan(plan: DiscoveryCapacityPlan): Record<string, unknown> {
  const r2v = plan.funnel.raw_to_verified;
  return {
    // Existing fields (semantics documented in discovery-capacity.ts header).
    daily_raw_requirement: plan.daily_raw_requirement,
    effective_raw_target: plan.effective_raw_target,
    effective_verified_target: plan.effective_verified_target,
    active_pitching_songs: plan.active_pitching_songs,
    // Objective; raw research is uncapped (effective_raw_target is guidance only).
    objective_verified_total: plan.objective_verified_total,
    raw_research_capped: plan.raw_research_capped,
    // The working behind the estimate.
    daily_raw_requirement_basis: plan.daily_raw_requirement_basis,
    measurement_status: plan.measurement_status,
    conversion_rate: r2v.rate,
    numerator: r2v.numerator,
    denominator: r2v.denominator,
    sample_size: r2v.sample_size,
    window: r2v.window,
    fallback_used: plan.fallback_used,
    fallback_rate: plan.fallback_rate,
    measurement_error: r2v.error,
    funnel: plan.funnel,
    settings_status: plan.settings_status,
    warnings: plan.warnings,
  };
}

export type QueryRotationPick = {
  profile_id: string;
  profile_key: string;
  query: string;
  saturated: boolean;
};

/**
 * Pick next unused query from approved profiles, skipping saturated surfaces
 * for the current CT business date. Never pads with duplicates.
 */
export async function pickUnsaturatedQueries(
  sb: SupabaseClient,
  opts?: { limit?: number; businessDateCt?: string },
): Promise<QueryRotationPick[]> {
  const businessDate = opts?.businessDateCt ?? chicagoBusinessDate();
  const limit = Math.min(opts?.limit ?? 20, 100);

  const { data: profiles } = await sb
    .from("discovery_profiles")
    .select(
      "id, profile_key, is_active, approval_status, query_templates, included_search_terms, prior_query_cooldown_hours",
    )
    .eq("is_active", true)
    .eq("approval_status", "approved");

  const { data: sat } = await sb
    .from("discovery_saturation_log")
    .select("discovery_profile_id, query_key")
    .eq("business_date_ct", businessDate)
    .eq("saturated", true);

  const satKeys = new Set(
    (sat ?? []).map((s) => `${s.discovery_profile_id}::${s.query_key}`),
  );

  const out: QueryRotationPick[] = [];
  for (const p of profiles ?? []) {
    const templates = [
      ...((p.query_templates as string[] | null) ?? []),
      ...((p.included_search_terms as string[] | null) ?? []),
    ];
    for (const q of templates) {
      const query = String(q).trim();
      if (!query) continue;
      const key = `${p.id}::${query}`;
      const saturated = satKeys.has(key);
      if (saturated) continue;
      out.push({
        profile_id: p.id as string,
        profile_key: p.profile_key as string,
        query,
        saturated: false,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export async function recordSaturation(
  sb: SupabaseClient,
  opts: {
    discovery_profile_id: string;
    query_key: string;
    source_domain?: string | null;
    business_date_ct?: string;
    raw_results?: number;
    unique_results?: number;
    notes?: string | null;
    recorded_by?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const row = {
    discovery_profile_id: opts.discovery_profile_id,
    query_key: opts.query_key,
    source_domain: opts.source_domain ?? null,
    business_date_ct: opts.business_date_ct ?? chicagoBusinessDate(),
    saturated: true,
    raw_results: opts.raw_results ?? 0,
    unique_results: opts.unique_results ?? 0,
    notes: opts.notes ?? null,
    recorded_by: opts.recorded_by ?? null,
  };
  const { error } = await sb.from("discovery_saturation_log").upsert(row, {
    onConflict: "discovery_profile_id,query_key,business_date_ct",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
