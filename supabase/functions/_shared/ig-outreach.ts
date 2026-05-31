import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isArtistIgHandle } from "./curator-filters.ts";
import {
  isValidCuratorIgHandle,
  sanitizeCuratorIgHandle,
} from "./contact-extract.ts";
import { loadLanesConfig } from "./playlist-lanes.ts";
import { loadCatalogTracks, pickCatalogTrackForPlacement } from "./catalog-match.ts";
import { requireMutualForQueue } from "./ig-roster.ts";
import { buildIgOutreachPackage, nextDmRef } from "./outreach-templates.ts";

export const IG_DM_DAILY_CAP = 10;

function featuringTracks(row: Record<string, unknown>): string[] {
  const rc = row.research_context as Record<string, unknown> | null;
  const raw = rc?.featuring_tracks;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return [];
}

/** @deprecated Use buildIgOutreachPackage — kept for callers not yet migrated */
export function buildPersonalizedIgDm(
  row: Record<string, unknown>,
  pitchTrackName: string,
  streamLink: string,
  engagementType: "thank_you" | "cross_pitch" | "thank_and_pitch",
): string {
  const pkg = buildIgOutreachPackage(
    row,
    pitchTrackName,
    "legacy",
    streamLink,
    engagementType,
    null,
    `FF-IG-LEGACY-${String(row.playlist_id ?? "x").slice(-6)}`,
  );
  return pkg.dm_body;
}

export async function countIgDmsToday(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("social_engagement_queue")
    .select("*", { count: "exact", head: true })
    .eq("platform", "instagram")
    .eq("action", "pitch_dm")
    .in("status", ["pending", "sent"])
    .gte("created_at", start.toISOString());
  return count ?? 0;
}

export async function countIgDmsSentToday(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("social_engagement_queue")
    .select("*", { count: "exact", head: true })
    .eq("platform", "instagram")
    .eq("status", "sent")
    .gte("performed_at", start.toISOString());
  return count ?? 0;
}

export type IgQueueInsert = {
  draft_text: string;
  operator_brief: string;
  dm_ref: string;
  ig_handle: string;
  meta: Record<string, unknown>;
};

export async function buildIgQueueInsert(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  pitchTrack: string,
  pitchReason: string,
  streamLink: string,
  engagementType: "thank_you" | "cross_pitch" | "thank_and_pitch",
  requireMutual: boolean,
  extraMeta?: Record<string, unknown>,
): Promise<{ ok: true; insert: IgQueueInsert } | { ok: false; reason: string }> {
  const handle = ((row.curator_submission_dm as string) || (row.curator_instagram as string) || "")
    .replace(/^@/, "").trim();
  if (!handle || !isValidCuratorIgHandle(handle)) {
    return { ok: false, reason: "invalid_ig" };
  }
  const mutual = await requireMutualForQueue(sb, handle, requireMutual);
  if (!mutual.ok) return { ok: false, reason: mutual.reason ?? "not_mutual" };

  const dmRef = await nextDmRef(sb);
  const pkg = buildIgOutreachPackage(
    row,
    pitchTrack,
    pitchReason,
    streamLink,
    engagementType,
    mutual.roster ?? null,
    dmRef,
  );

  return {
    ok: true,
    insert: {
      draft_text: pkg.dm_body,
      operator_brief: pkg.operator_brief,
      dm_ref: dmRef,
      ig_handle: handle.toLowerCase(),
      meta: {
        lane: row.lane,
        engagement_type: engagementType,
        pitch_track: pitchTrack,
        pitch_reason: pitchReason,
        featuring: featuringTracks(row),
        mutual_ok: pkg.identity.mutual_ok,
        dm_ref: dmRef,
        email_subject: pkg.email.subject,
        email_body: pkg.email.body,
        ...extraMeta,
      },
    },
  };
}

export async function queueIgDm(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  insert: IgQueueInsert,
): Promise<boolean> {
  const playlistId = String(row.playlist_id ?? "");

  const { data: existing } = await sb.from("social_engagement_queue")
    .select("id")
    .eq("playlist_id", playlistId)
    .eq("platform", "instagram")
    .in("status", ["pending", "sent"])
    .limit(1)
    .maybeSingle();
  if (existing?.id) return false;

  const { error } = await sb.from("social_engagement_queue").insert({
    platform: "instagram",
    action: "pitch_dm",
    target_url: `https://www.instagram.com/${insert.ig_handle}/`,
    draft_text: insert.draft_text,
    operator_brief: insert.operator_brief,
    dm_ref: insert.dm_ref,
    ig_handle: insert.ig_handle,
    playlist_id: playlistId,
    status: "pending",
    result: insert.meta,
  });
  return !error;
}

export async function runQueueIgOutreachBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  resolveStreamLink: (trackName: string) => Promise<string>,
  rowDiscoveryReferences: (row: Record<string, unknown>, lanes: Record<string, unknown>, refs: string[]) => string[],
): Promise<{ status: number; data: Record<string, unknown> }> {
  const explicitTrack = String(body.track_name ?? "").trim();
  const autoMatch = Boolean(body.auto_match_track ?? !explicitTrack);
  const lane = String(body.lane ?? "").trim();
  const engagementType = String(body.engagement_type ?? "thank_and_pitch") as
    "thank_you" | "cross_pitch" | "thank_and_pitch";
  const limit = Math.min(IG_DM_DAILY_CAP, Math.max(1, Number(body.limit) || IG_DM_DAILY_CAP));
  const placementOnly = Boolean(body.placement_only ?? true);
  const requireMutual = body.require_mutual !== false;
  const bodyRefs = Array.isArray(body.references) ? body.references.map(String) : [];

  if (!explicitTrack && !autoMatch) {
    return { status: 400, data: { error: "track_name or auto_match_track required" } };
  }

  const catalog = await loadCatalogTracks(sb);
  const fallbackTrack = explicitTrack || catalog[0]?.name || "Designed For Me (Control)";

  const sentToday = await countIgDmsSentToday(sb);
  const queuedToday = await countIgDmsToday(sb);
  const remaining = Math.max(0, IG_DM_DAILY_CAP - queuedToday);
  if (remaining <= 0) {
    return {
      status: 429,
      data: {
        error: `IG DM daily cap reached (${IG_DM_DAILY_CAP}/day UTC). Mark sent items or wait until tomorrow.`,
        cap: IG_DM_DAILY_CAP,
        queued_today: queuedToday,
        sent_today: sentToday,
      },
    };
  }

  const batchSize = Math.min(limit, remaining);
  let q = sb.from("playlist_targets")
    .select("*")
    .eq("is_active", true)
    .not("curator_instagram", "is", null)
    .neq("pitch_status", "disclaim_brand")
    .order("follower_count", { ascending: false, nullsFirst: false })
    .limit(80);

  if (lane) q = q.eq("lane", lane);
  if (placementOnly) {
    q = q.or("research_context->>source.eq.spotify_placement,research_context->>source.eq.spotify_for_artists_csv");
  }

  const { data: rows, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };

  const lanes = await loadLanesConfig(sb);
  const queued: string[] = [];
  const skipped: Record<string, string> = {};

  for (const row of rows ?? []) {
    if (queued.length >= batchSize) break;
    const rawIg = (row.curator_submission_dm as string) || (row.curator_instagram as string) || "";
    const handle = sanitizeCuratorIgHandle(rawIg.replace(/^@/, ""));
    if (!handle) {
      skipped[row.playlist_id] = "invalid_ig";
      continue;
    }
    const refs = rowDiscoveryReferences(row, lanes, bodyRefs);
    if (isArtistIgHandle(handle, refs)) {
      skipped[row.playlist_id] = "artist_ig";
      continue;
    }

    const { track: pitchTrack, reason: pitchReason } = autoMatch && !explicitTrack
      ? pickCatalogTrackForPlacement(row, catalog, fallbackTrack)
      : { track: fallbackTrack, reason: explicitTrack ? "Manual track" : "Catalog default" };

    const streamLink = await resolveStreamLink(pitchTrack);
    const built = await buildIgQueueInsert(
      sb,
      row,
      pitchTrack,
      pitchReason,
      streamLink,
      engagementType,
      requireMutual,
      { source: "queue_ig_outreach_batch", variant_seed: row.playlist_id },
    );
    if (!built.ok) {
      skipped[row.playlist_id] = built.reason;
      continue;
    }
    const ok = await queueIgDm(sb, row, built.insert);
    if (ok) queued.push(row.playlist_id);
    else skipped[row.playlist_id] = "duplicate_or_failed";
  }

  return {
    status: 200,
    data: {
      ok: true,
      queued: queued.length,
      playlist_ids: queued,
      skipped,
      cap: IG_DM_DAILY_CAP,
      remaining_today: Math.max(0, IG_DM_DAILY_CAP - queuedToday - queued.length),
      engagement_type: engagementType,
      require_mutual: requireMutual,
      auto_match_track: autoMatch,
    },
  };
}
