/**
 * Discovery capacity planning from ops_settings (editable) — not code constants.
 *
 * daily_raw = ceil((30 × active_pitching_songs) ÷ trailing_7d_verified_to_draft_rate)
 * Interim floors remain as editable settings (default 45 raw / 30 verified per song).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { chicagoBusinessDate } from "./chicago-time.ts";

export type DiscoveryCapacityPlan = {
  active_pitching_songs: number;
  target_verified_per_song_per_day: number;
  trailing_conversion_rate: number;
  daily_raw_requirement: number;
  interim_raw_floor_total: number;
  interim_verified_floor_total: number;
  effective_raw_target: number;
  effective_verified_target: number;
  lookback_days: number;
  settings: Record<string, unknown>;
};

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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

export async function loadDiscoveryCapacitySettings(
  sb: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { data } = await sb
    .from("ops_settings")
    .select("setting_value")
    .eq("setting_key", "discovery_capacity")
    .maybeSingle();
  const v = (data?.setting_value ?? {}) as Record<string, unknown>;
  return {
    interim_raw_floor_per_song: num(v.interim_raw_floor_per_song, 45),
    interim_verified_floor_per_song: num(v.interim_verified_floor_per_song, 30),
    target_verified_per_song_per_day: num(v.target_verified_per_song_per_day, 30),
    trailing_conversion_lookback_days: num(v.trailing_conversion_lookback_days, 7),
    min_conversion_rate: num(v.min_conversion_rate, 0.05),
  };
}

/**
 * Trailing verified→draft conversion:
 *   (# distinct playlist targets verified in window that have ≥1 outreach draft)
 *   ÷ (# playlist targets verified in window)
 *
 * Not drafts_created / verified_count as independent global counts.
 */
export async function estimateVerifiedToDraftConversion(
  sb: SupabaseClient,
  lookbackDays: number,
): Promise<number> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - Math.max(1, lookbackDays));
  const sinceIso = since.toISOString();

  const { data: verifiedRows, error: vErr } = await sb
    .from("playlist_targets")
    .select("playlist_id")
    .in("verification_status", ["auto_verified", "manually_verified"])
    .gte("last_verified_at", sinceIso);
  if (vErr) {
    console.error("estimateVerifiedToDraftConversion verified:", vErr.message);
    return 0;
  }
  const verifiedIds = [...new Set((verifiedRows ?? []).map((r) => String(r.playlist_id)).filter(Boolean))];
  if (verifiedIds.length === 0) return 0;

  // Chunk IN queries to avoid PostgREST URL limits.
  const drafted = new Set<string>();
  const chunkSize = 100;
  for (let i = 0; i < verifiedIds.length; i += chunkSize) {
    const chunk = verifiedIds.slice(i, i + chunkSize);
    const { data: draftRows, error: dErr } = await sb
      .from("outreach_drafts")
      .select("playlist_id")
      .in("playlist_id", chunk)
      .gte("created_at", sinceIso);
    if (dErr) {
      console.error("estimateVerifiedToDraftConversion drafts:", dErr.message);
      continue;
    }
    for (const d of draftRows ?? []) {
      if (d.playlist_id) drafted.add(String(d.playlist_id));
    }
  }

  return Math.min(1, drafted.size / verifiedIds.length);
}

/** Pure helper for tests — same formula without I/O. */
export function verifiedToDraftRate(verifiedIds: string[], draftedIds: string[]): number {
  const verified = new Set(verifiedIds.filter(Boolean));
  if (verified.size === 0) return 0;
  const drafted = new Set(draftedIds.filter((id) => verified.has(id)));
  return Math.min(1, drafted.size / verified.size);
}

export async function buildDiscoveryCapacityPlan(
  sb: SupabaseClient,
  activePitchingSongs: number,
): Promise<DiscoveryCapacityPlan> {
  const settings = await loadDiscoveryCapacitySettings(sb);
  const lookback = num(settings.trailing_conversion_lookback_days, 7);
  const conversion = await estimateVerifiedToDraftConversion(sb, lookback);
  const perSong = num(settings.target_verified_per_song_per_day, 30);
  const minRate = num(settings.min_conversion_rate, 0.05);
  const dailyRaw = computeDailyRawRequirement({
    activePitchingSongs,
    targetVerifiedPerSong: perSong,
    conversionRate: conversion,
    minConversionRate: minRate,
  });
  const rawFloor = Math.ceil(num(settings.interim_raw_floor_per_song, 45) * activePitchingSongs);
  const verifiedFloor = Math.ceil(
    num(settings.interim_verified_floor_per_song, 30) * activePitchingSongs,
  );
  return {
    active_pitching_songs: activePitchingSongs,
    target_verified_per_song_per_day: perSong,
    trailing_conversion_rate: conversion,
    daily_raw_requirement: dailyRaw,
    interim_raw_floor_total: rawFloor,
    interim_verified_floor_total: verifiedFloor,
    effective_raw_target: Math.max(dailyRaw, rawFloor),
    effective_verified_target: verifiedFloor,
    lookback_days: lookback,
    settings,
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
