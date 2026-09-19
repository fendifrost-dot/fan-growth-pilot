// YouTube native share-seeding pilot — operator surface handlers.
//
// Modular and separate from playlist/sync/DNA/licensing. All writes are gated
// by the manage_youtube_shares capability (Fendi + human_admin only) in
// outreach-auth.ts; this module trusts that gate and never re-derives identity.
//
// Invariants enforced here (defense-in-depth alongside DB constraints):
//   - A campaign cannot go active without a youtube_video_id.
//   - Outreach / events cannot be recorded against a non-active campaign.
//   - A share counts only when verify_youtube_share_event sets it to verified.
//   - Measurement never asserts causal attribution — we store raw windows and
//     compute Observed Lift (window vs baseline) for display only.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { OpsActor } from "./ops-actors.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

const CAMPAIGN_TYPES = new Set(["catalog_resurface", "cultural_topical", "current_release"]);
const CAMPAIGN_STATUSES = new Set(["active", "paused", "disabled"]);
const QUALIFICATION = new Set(["pending", "qualified", "disqualified"]);
const FUNNEL_STAGES = [
  "discovered",
  "qualified",
  "outreach_ready",
  "contacted",
  "responded",
  "agreed",
  "shared",
  "verified",
  "performance_window",
  "retest_candidate",
] as const;
const FUNNEL_SET = new Set<string>(FUNNEL_STAGES);
const OUTREACH_STATUSES = new Set(["draft", "ready", "contacted", "responded", "agreed", "declined"]);
const SHARE_TYPES = new Set(["community_post", "timestamp_share", "creator_share", "comment", "other"]);
const METRIC_WINDOWS = new Set(["baseline", "plus_24h", "plus_72h", "plus_7d"]);
const SCORE_KEYS = [
  "audience_fit_score",
  "activity_score",
  "authenticity_score",
  "share_probability_score",
  "estimated_impact_score",
] as const;

export const YOUTUBE_SHARE_ACTIONS = [
  // reads
  "list_youtube_share_campaigns",
  "get_youtube_share_campaign",
  "list_youtube_share_targets",
  "list_youtube_share_moments",
  "list_youtube_share_outreach",
  "list_youtube_share_events",
  "get_youtube_share_measurement",
  // writes
  "upsert_youtube_share_campaign",
  "upsert_youtube_share_target",
  "set_youtube_share_target_stage",
  "upsert_youtube_share_moment",
  "delete_youtube_share_moment",
  "upsert_youtube_share_outreach",
  "record_youtube_share_event",
  "verify_youtube_share_event",
  "reject_youtube_share_event",
  "record_youtube_share_metric",
] as const;

export function isYouTubeShareAction(action: string): boolean {
  return (YOUTUBE_SHARE_ACTIONS as readonly string[]).includes(action);
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s.length ? s : null;
}
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
}
function scoreOrNull(v: unknown): number | null | { error: string } {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: "scores must be 0-100" };
  return n;
}
function bigOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

type LoadResult =
  | { kind: "ok"; row: Record<string, unknown> }
  | { kind: "error"; error: string }
  | { kind: "missing" };

async function loadRow(sb: SupabaseClient, table: string, id: string): Promise<LoadResult> {
  const { data, error } = await sb.from(table).select("*").eq("id", id).maybeSingle();
  if (error) return { kind: "error", error: error.message };
  if (!data) return { kind: "missing" };
  return { kind: "ok", row: data as Record<string, unknown> };
}

function loadCampaign(sb: SupabaseClient, id: string): Promise<LoadResult> {
  return loadRow(sb, "youtube_share_campaigns", id);
}

function loadTarget(sb: SupabaseClient, id: string): Promise<LoadResult> {
  return loadRow(sb, "youtube_share_targets", id);
}

/** Sum a metric field across the rows of one window (nulls ignored). */
function windowTotals(rows: Record<string, unknown>[], label: string) {
  const w = rows.filter((r) => r.window_label === label);
  const sum = (k: string) =>
    w.reduce((acc, r) => acc + (r[k] == null ? 0 : Number(r[k])), 0);
  const has = w.length > 0;
  return {
    present: has,
    captured_at: has ? w[0].captured_at : null,
    impressions: has ? sum("impressions") : null,
    views: has ? sum("views") : null,
    likes: has ? sum("likes") : null,
    comments: has ? sum("comments") : null,
  };
}

export async function runYouTubeShareAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  opsActor: OpsActor,
): Promise<RunResult> {
  // ---- Reads --------------------------------------------------------------
  if (action === "list_youtube_share_campaigns") {
    const { data, error } = await sb
      .from("youtube_share_campaigns")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "get_youtube_share_campaign") {
    const id = str(body.campaign_id ?? body.id);
    if (!id) return { status: 400, data: { error: "campaign_id required" } };
    const c = await loadCampaign(sb, id);
    if (c.kind === "error") return { status: 500, data: { error: c.error } };
    if (c.kind === "missing") return { status: 404, data: { error: "campaign not found" } };
    const [targets, moments, events] = await Promise.all([
      sb.from("youtube_share_targets").select("funnel_stage, qualification_status").eq("campaign_id", id),
      sb.from("youtube_share_moments").select("id").eq("campaign_id", id),
      sb.from("youtube_share_events").select("verification_status").eq("campaign_id", id),
    ]);
    const tRows = (targets.data ?? []) as Record<string, unknown>[];
    const eRows = (events.data ?? []) as Record<string, unknown>[];
    return {
      status: 200,
      data: {
        ok: true,
        campaign: c.row,
        counts: {
          targets: tRows.length,
          qualified: tRows.filter((r) => r.qualification_status === "qualified").length,
          moments: (moments.data ?? []).length,
          shares_verified: eRows.filter((r) => r.verification_status === "verified").length,
          shares_pending: eRows.filter((r) => r.verification_status === "pending").length,
        },
      },
    };
  }

  if (action === "list_youtube_share_targets") {
    let q = sb.from("youtube_share_targets").select("*");
    if (body.campaign_id) q = q.eq("campaign_id", str(body.campaign_id));
    if (body.category) q = q.eq("category", str(body.category));
    if (body.qualification_status) q = q.eq("qualification_status", str(body.qualification_status));
    if (body.funnel_stage) q = q.eq("funnel_stage", str(body.funnel_stage));
    const minFit = intOrNull(body.min_audience_fit_score);
    if (minFit !== null) q = q.gte("audience_fit_score", minFit);
    const minShare = intOrNull(body.min_share_probability_score);
    if (minShare !== null) q = q.gte("share_probability_score", minShare);
    q = q.order("share_probability_score", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(Math.min(500, Math.max(1, Number(body.limit) || 200)));
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "list_youtube_share_moments") {
    let q = sb.from("youtube_share_moments").select("*");
    if (body.campaign_id) q = q.eq("campaign_id", str(body.campaign_id));
    const { data, error } = await q.order("sort_rank", { ascending: true }).order("created_at", { ascending: true });
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "list_youtube_share_outreach") {
    let q = sb.from("youtube_share_outreach").select("*");
    if (body.campaign_id) q = q.eq("campaign_id", str(body.campaign_id));
    if (body.target_id) q = q.eq("target_id", str(body.target_id));
    if (body.status) q = q.eq("status", str(body.status));
    const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "list_youtube_share_events") {
    let q = sb.from("youtube_share_events").select("*");
    if (body.campaign_id) q = q.eq("campaign_id", str(body.campaign_id));
    if (body.target_id) q = q.eq("target_id", str(body.target_id));
    if (body.verification_status) q = q.eq("verification_status", str(body.verification_status));
    const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "get_youtube_share_measurement") {
    const id = str(body.campaign_id);
    if (!id) return { status: 400, data: { error: "campaign_id required" } };
    let q = sb.from("youtube_share_metrics").select("*").eq("campaign_id", id);
    if (body.target_id) q = q.eq("target_id", str(body.target_id));
    const { data, error } = await q.order("captured_at", { ascending: true });
    if (error) return { status: 500, data: { error: error.message } };
    const rows = (data ?? []) as Record<string, unknown>[];
    const baseline = windowTotals(rows, "baseline");
    const windows = ["plus_24h", "plus_72h", "plus_7d"].map((label) => {
      const w = windowTotals(rows, label);
      // Observed Lift = window − baseline (never labeled "views generated").
      const lift = (k: "impressions" | "views" | "likes" | "comments") =>
        w.present && baseline.present && w[k] !== null && baseline[k] !== null
          ? Number(w[k]) - Number(baseline[k])
          : null;
      return {
        window_label: label,
        ...w,
        observed_lift: {
          impressions: lift("impressions"),
          views: lift("views"),
          likes: lift("likes"),
          comments: lift("comments"),
        },
      };
    });
    return {
      status: 200,
      data: { ok: true, rows, baseline, windows, disclaimer: "Observed Lift — not attributed views." },
    };
  }

  // ---- Writes (manage_youtube_shares) -------------------------------------
  if (action === "upsert_youtube_share_campaign") {
    const id = strOrNull(body.id);
    const type = str(body.campaign_type);
    if (!id && !CAMPAIGN_TYPES.has(type)) {
      return { status: 400, data: { error: "valid campaign_type required" } };
    }
    const status = strOrNull(body.status);
    if (status && !CAMPAIGN_STATUSES.has(status)) {
      return { status: 400, data: { error: "invalid status" } };
    }
    const videoId = body.youtube_video_id === undefined ? undefined : strOrNull(body.youtube_video_id);

    // Guard: activating requires a video id (from body or existing row).
    if (status === "active") {
      let effectiveVideo = videoId ?? null;
      if (effectiveVideo === null && id) {
        const existing = await loadCampaign(sb, id);
        if (existing.kind === "ok") effectiveVideo = strOrNull(existing.row.youtube_video_id);
      }
      if (!effectiveVideo) {
        return { status: 400, data: { error: "cannot activate a campaign without a youtube_video_id" } };
      }
    }

    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.track_label !== undefined) fields.track_label = str(body.track_label);
    if (body.track_id !== undefined) fields.track_id = strOrNull(body.track_id);
    if (!id && CAMPAIGN_TYPES.has(type)) fields.campaign_type = type;
    if (videoId !== undefined) fields.youtube_video_id = videoId;
    if (status) fields.status = status;
    if (body.content_guardrails !== undefined) fields.content_guardrails = strOrNull(body.content_guardrails);
    if (body.notes !== undefined) fields.notes = strOrNull(body.notes);

    if (id) {
      const { data, error } = await sb.from("youtube_share_campaigns").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, row: data } };
    }
    if (!str(body.track_label)) return { status: 400, data: { error: "track_label required" } };
    const { data, error } = await sb.from("youtube_share_campaigns").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "upsert_youtube_share_target") {
    const id = strOrNull(body.id);
    const campaignId = strOrNull(body.campaign_id);
    if (!id && !campaignId) return { status: 400, data: { error: "campaign_id required" } };
    if (!id && !str(body.channel_name)) return { status: 400, data: { error: "channel_name required" } };

    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (campaignId && !id) fields.campaign_id = campaignId;
    if (body.channel_name !== undefined) fields.channel_name = str(body.channel_name);
    if (body.channel_url !== undefined) fields.channel_url = strOrNull(body.channel_url);
    if (body.channel_youtube_id !== undefined) fields.channel_youtube_id = strOrNull(body.channel_youtube_id);
    if (body.category !== undefined) fields.category = strOrNull(body.category);
    if (body.subscriber_count !== undefined) fields.subscriber_count = intOrNull(body.subscriber_count);
    for (const k of SCORE_KEYS) {
      if (body[k] !== undefined) {
        const v = scoreOrNull(body[k]);
        if (v && typeof v === "object") return { status: 400, data: { error: v.error } };
        fields[k] = v;
      }
    }
    if (body.qualification_status !== undefined) {
      const qs = str(body.qualification_status);
      if (!QUALIFICATION.has(qs)) return { status: 400, data: { error: "invalid qualification_status" } };
      fields.qualification_status = qs;
    }
    if (body.disqualified_reason !== undefined) fields.disqualified_reason = strOrNull(body.disqualified_reason);
    if (body.funnel_stage !== undefined) {
      const fs = str(body.funnel_stage);
      if (!FUNNEL_SET.has(fs)) return { status: 400, data: { error: "invalid funnel_stage" } };
      fields.funnel_stage = fs;
    }
    if (body.notes !== undefined) fields.notes = strOrNull(body.notes);
    if (!id) fields.discovered_by = opsActor.label;

    if (id) {
      const { data, error } = await sb.from("youtube_share_targets").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, row: data } };
    }
    const { data, error } = await sb.from("youtube_share_targets").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "set_youtube_share_target_stage") {
    const id = str(body.target_id ?? body.id);
    const stage = str(body.funnel_stage);
    if (!id) return { status: 400, data: { error: "target_id required" } };
    if (!FUNNEL_SET.has(stage)) return { status: 400, data: { error: "invalid funnel_stage" } };
    const { data, error } = await sb
      .from("youtube_share_targets")
      .update({ funnel_stage: stage, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "upsert_youtube_share_moment") {
    const id = strOrNull(body.id);
    const campaignId = strOrNull(body.campaign_id);
    if (!id && !campaignId) return { status: 400, data: { error: "campaign_id required" } };
    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (campaignId && !id) fields.campaign_id = campaignId;
    if (body.timestamp_seconds !== undefined) fields.timestamp_seconds = intOrNull(body.timestamp_seconds);
    if (body.timestamp_label !== undefined) fields.timestamp_label = strOrNull(body.timestamp_label);
    if (body.angle !== undefined) fields.angle = strOrNull(body.angle);
    if (body.suggested_caption !== undefined) fields.suggested_caption = strOrNull(body.suggested_caption);
    if (body.why_audience_cares !== undefined) fields.why_audience_cares = strOrNull(body.why_audience_cares);
    if (body.audience_segment !== undefined) fields.audience_segment = strOrNull(body.audience_segment);
    if (body.is_primary !== undefined) fields.is_primary = Boolean(body.is_primary);
    if (body.sort_rank !== undefined) fields.sort_rank = intOrNull(body.sort_rank) ?? 0;
    if (id) {
      const { data, error } = await sb.from("youtube_share_moments").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, row: data } };
    }
    const { data, error } = await sb.from("youtube_share_moments").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "delete_youtube_share_moment") {
    const id = str(body.id ?? body.moment_id);
    if (!id) return { status: 400, data: { error: "id required" } };
    const { error } = await sb.from("youtube_share_moments").delete().eq("id", id);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }

  if (action === "upsert_youtube_share_outreach") {
    const id = strOrNull(body.id);
    const targetId = strOrNull(body.target_id);
    if (!id && !targetId) return { status: 400, data: { error: "target_id required" } };

    // On create, block outreach for non-active campaigns (Track C guard).
    let campaignId = strOrNull(body.campaign_id);
    if (!id) {
      const t = await loadTarget(sb, targetId!);
      if (t.kind === "error") return { status: 500, data: { error: t.error } };
      if (t.kind === "missing") return { status: 404, data: { error: "target not found" } };
      campaignId = str(t.row.campaign_id);
      const c = await loadCampaign(sb, campaignId);
      if (c.kind === "ok" && c.row.status !== "active") {
        return { status: 409, data: { error: "campaign is not active — outreach is blocked" } };
      }
    }

    const status = strOrNull(body.status);
    if (status && !OUTREACH_STATUSES.has(status)) return { status: 400, data: { error: "invalid status" } };

    const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (!id) {
      fields.target_id = targetId;
      fields.campaign_id = campaignId;
    }
    if (body.moment_id !== undefined) fields.moment_id = strOrNull(body.moment_id);
    if (body.channel !== undefined) fields.channel = str(body.channel) || "community_post";
    if (body.offer_type !== undefined) fields.offer_type = str(body.offer_type) || "audience_share";
    if (body.suggested_caption !== undefined) fields.suggested_caption = strOrNull(body.suggested_caption);
    if (body.message_body !== undefined) fields.message_body = strOrNull(body.message_body);
    if (status) {
      fields.status = status;
      if (status === "contacted" && body.contacted_at === undefined) fields.contacted_at = new Date().toISOString();
      if (status === "responded" && body.responded_at === undefined) fields.responded_at = new Date().toISOString();
    }
    if (body.response_notes !== undefined) fields.response_notes = strOrNull(body.response_notes);

    if (id) {
      const { data, error } = await sb.from("youtube_share_outreach").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, row: data } };
    }
    const { data, error } = await sb.from("youtube_share_outreach").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "record_youtube_share_event") {
    const targetId = str(body.target_id);
    if (!targetId) return { status: 400, data: { error: "target_id required" } };
    const t = await loadTarget(sb, targetId);
    if (t.kind === "error") return { status: 500, data: { error: t.error } };
    if (t.kind === "missing") return { status: 404, data: { error: "target not found" } };
    const campaignId = str(t.row.campaign_id);
    const c = await loadCampaign(sb, campaignId);
    if (c.kind === "ok" && c.row.status === "disabled") {
      return { status: 409, data: { error: "campaign is disabled — cannot record shares" } };
    }
    const shareType = str(body.share_type) || "community_post";
    if (!SHARE_TYPES.has(shareType)) return { status: 400, data: { error: "invalid share_type" } };
    const { data, error } = await sb
      .from("youtube_share_events")
      .insert({
        target_id: targetId,
        campaign_id: campaignId,
        moment_id: strOrNull(body.moment_id),
        share_type: shareType,
        share_url: strOrNull(body.share_url),
        verification_status: "pending",
        observed_at: strOrNull(body.observed_at),
        notes: strOrNull(body.notes),
      })
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    // Claimed, not counted — advance target to 'shared' (verification pending).
    await sb.from("youtube_share_targets")
      .update({ funnel_stage: "shared", updated_at: new Date().toISOString() })
      .eq("id", targetId)
      .in("funnel_stage", ["agreed", "responded", "contacted", "outreach_ready", "qualified", "discovered"]);
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "verify_youtube_share_event") {
    const id = str(body.event_id ?? body.id);
    if (!id) return { status: 400, data: { error: "event_id required" } };
    const { data, error } = await sb
      .from("youtube_share_events")
      .update({
        verification_status: "verified",
        verified_at: new Date().toISOString(),
        verified_by: opsActor.userId,
        verified_by_label: opsActor.label,
        rejected_reason: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    if (data?.target_id) {
      // Verified share is the only state that counts — advance the target.
      await sb.from("youtube_share_targets")
        .update({ funnel_stage: "verified", updated_at: new Date().toISOString() })
        .eq("id", data.target_id);
    }
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "reject_youtube_share_event") {
    const id = str(body.event_id ?? body.id);
    if (!id) return { status: 400, data: { error: "event_id required" } };
    const reason = strOrNull(body.rejected_reason ?? body.reason);
    const { data, error } = await sb
      .from("youtube_share_events")
      .update({
        verification_status: "rejected",
        rejected_reason: reason,
        verified_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "record_youtube_share_metric") {
    const campaignId = str(body.campaign_id);
    const windowLabel = str(body.window_label);
    if (!campaignId) return { status: 400, data: { error: "campaign_id required" } };
    if (!METRIC_WINDOWS.has(windowLabel)) return { status: 400, data: { error: "invalid window_label" } };
    const { data, error } = await sb
      .from("youtube_share_metrics")
      .insert({
        campaign_id: campaignId,
        target_id: strOrNull(body.target_id),
        share_event_id: strOrNull(body.share_event_id),
        window_label: windowLabel,
        captured_at: strOrNull(body.captured_at) ?? new Date().toISOString(),
        impressions: bigOrNull(body.impressions),
        views: bigOrNull(body.views),
        likes: bigOrNull(body.likes),
        comments: bigOrNull(body.comments),
        source: str(body.source) || "manual",
        notes: strOrNull(body.notes),
      })
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  return { status: 400, data: { error: `Unknown youtube-share action: ${action}` } };
}
