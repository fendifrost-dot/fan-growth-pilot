/**
 * Playlist category coverage audit.
 *
 * Genre-fit on the send gate fails closed when a playlist has zero categories.
 * Operators need a single CCA action to count coverage before arming
 * PITCH_IDENTITY_GATE / redeploying senders.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type CoverageSample = {
  playlist_id: string;
  playlist_name: string | null;
  curator_name: string | null;
  platform: string | null;
  is_active: boolean | null;
  category_count: number;
};

export type CoverageAudit = {
  ok: true;
  active_only: boolean;
  scanned: number;
  with_categories: number;
  without_categories: number;
  coverage_pct: number;
  sample_missing: CoverageSample[];
  sample_covered: CoverageSample[];
};

type TargetRow = {
  playlist_id: string;
  playlist_name: string | null;
  curator_name: string | null;
  platform: string | null;
  is_active: boolean | null;
  playlist_categories?: { category_id: string }[] | null;
};

export function summarizeCategoryCoverage(
  rows: TargetRow[],
  opts: { sampleLimit?: number } = {},
): Omit<CoverageAudit, "ok" | "active_only"> {
  const sampleLimit = Math.min(100, Math.max(1, opts.sampleLimit ?? 25));
  const missing: CoverageSample[] = [];
  const covered: CoverageSample[] = [];
  let withCats = 0;
  let withoutCats = 0;

  for (const row of rows) {
    const count = Array.isArray(row.playlist_categories) ? row.playlist_categories.length : 0;
    const sample: CoverageSample = {
      playlist_id: String(row.playlist_id),
      playlist_name: row.playlist_name ?? null,
      curator_name: row.curator_name ?? null,
      platform: row.platform ?? null,
      is_active: row.is_active ?? null,
      category_count: count,
    };
    if (count === 0) {
      withoutCats += 1;
      if (missing.length < sampleLimit) missing.push(sample);
    } else {
      withCats += 1;
      if (covered.length < sampleLimit) covered.push(sample);
    }
  }

  const scanned = rows.length;
  const coverage_pct = scanned === 0 ? 0 : Math.round((withCats / scanned) * 1000) / 10;

  return {
    scanned,
    with_categories: withCats,
    without_categories: withoutCats,
    coverage_pct,
    sample_missing: missing,
    sample_covered: covered,
  };
}

export async function auditPlaylistCategoryCoverage(
  sb: SupabaseClient,
  opts: { activeOnly?: boolean; sampleLimit?: number } = {},
): Promise<CoverageAudit> {
  const activeOnly = opts.activeOnly !== false;
  let q = sb
    .from("playlist_targets")
    .select(
      "playlist_id, playlist_name, curator_name, platform, is_active, playlist_categories(category_id)",
    )
    .order("follower_count", { ascending: false, nullsFirst: false })
    .limit(5000);
  if (activeOnly) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const summary = summarizeCategoryCoverage((data ?? []) as TargetRow[], {
    sampleLimit: opts.sampleLimit,
  });

  return {
    ok: true,
    active_only: activeOnly,
    ...summary,
  };
}
