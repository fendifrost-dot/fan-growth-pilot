/**
 * Shared server-side outreach decision — single choke point for automated
 * playlist targeting, drafting, approval, and send.
 *
 * Always enforced (no shadow mode, no legacy genre authorization):
 *   - Exact track_id + playlist_id required
 *   - Current Fendi-approved Song DNA required (tracks.approved_song_dna_version_id)
 *   - DNA must belong to the track, approval_state=approved, and match the pointer
 *   - Target lane required, verified, in DNA approved_lanes, not in excluded_lanes
 *   - Pitch copy exclusively from approved DNA short_pitch (no track/legacy fallback)
 *   - Playlist/lane copy is fit metadata only — never {{pitch}}
 *   - General override_category_check is forbidden
 *   - Legacy track_categories / trackGenre have zero authorization power
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  missingPitchCopyResult,
  resolveFitReason,
  resolveTrackPitchCopy,
  type FitReasonResult,
  type TrackPitchResult,
} from "./pitch-copy.ts";
import { loadLanesConfig } from "./playlist-lanes.ts";
import type { OpsActor } from "./ops-actors.ts";

export type OutreachDecisionInput = {
  route: string;
  trackId?: string | null;
  trackName?: string | null;
  campaignId?: string | null;
  songDnaVersionId?: string | null;
  playlistId?: string | null;
  lane?: string | null;
  /** Forbidden for ordinary admins / agents. */
  overrideCategoryCheck?: boolean;
  overrideReason?: string | null;
  overrideActorUserId?: string | null;
  isFendiAdmin?: boolean;
  /** Server-derived actor only — never from request-body identity fields. */
  actor?: OpsActor | null;
};

export type OutreachDecision = {
  allow: boolean;
  code: string;
  trackId: string | null;
  trackName: string | null;
  campaignId: string | null;
  songDnaVersionId: string | null;
  playlistId: string | null;
  targetLane: string | null;
  targetVerificationStatus: string | null;
  targetClassificationVerified: boolean;
  laneInApprovedSet: boolean | null;
  laneInExcludedSet: boolean | null;
  pitch: TrackPitchResult;
  fitReason: FitReasonResult;
  copySource: string | null;
  actor: string | null;
  errors: string[];
  compatible: boolean;
  contradictionExplanation: string | null;
  auditEvidence: Record<string, unknown>;
};

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function lower(v: unknown): string {
  return trim(v).toLowerCase();
}

/** Matches verify-target.ts VERIFIED_STATUSES. */
const VERIFIED_STATUSES = new Set(["auto_verified", "manually_verified"]);

async function tableExists(sb: SupabaseClient, table: string): Promise<boolean> {
  try {
    const { error } = await sb.from(table).select("*", { count: "exact", head: true }).limit(1);
    if (!error) return true;
    const msg = (error.message || "").toLowerCase();
    return !(msg.includes("does not exist") || msg.includes("could not find") || msg.includes("relation"));
  } catch {
    return false;
  }
}

async function logDecision(
  sb: SupabaseClient,
  decision: OutreachDecision,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("outreach_decision_shadow_log").insert({
      route: detail.route ?? decision.code,
      mode: "enforce",
      would_allow: decision.allow,
      decision_code: decision.code,
      track_id: decision.trackId,
      song_dna_version_id: decision.songDnaVersionId,
      campaign_id: decision.campaignId,
      playlist_id: decision.playlistId,
      detail: {
        ...detail,
        errors: decision.errors,
        audit: decision.auditEvidence,
        actor: decision.actor,
        target_lane: decision.targetLane,
        copy_source: decision.copySource,
      },
    });
  } catch (e) {
    console.error("outreach decision log failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * One shared eligibility + DNA envelope + copy decision for every operational route.
 * Always blocks on failure — no shadow/legacy authorization bypass.
 */
export async function evaluateOutreachDecision(
  sb: SupabaseClient,
  input: OutreachDecisionInput,
): Promise<OutreachDecision> {
  const errors: string[] = [];
  const trackId = trim(input.trackId);
  const campaignId = trim(input.campaignId);
  const playlistId = trim(input.playlistId);
  let trackName = trim(input.trackName);
  let songDnaVersionId = trim(input.songDnaVersionId);
  const actorLabel = input.actor?.label ?? null;

  if (!trackId) errors.push("missing_track_id");
  if (!playlistId) errors.push("missing_playlist_id");

  let trackRow: {
    id: string;
    name: string;
    short_pitch: string | null;
    pitch_angle: string | null;
    approved_song_dna_version_id: string | null;
  } | null = null;

  if (trackId) {
    const { data } = await sb
      .from("tracks")
      .select("id, name, short_pitch, pitch_angle, approved_song_dna_version_id")
      .eq("id", trackId)
      .maybeSingle();
    if (!data) {
      errors.push("track_id_not_found");
    } else {
      trackRow = data as {
        id: string;
        name: string;
        short_pitch: string | null;
        pitch_angle: string | null;
        approved_song_dna_version_id: string | null;
      };
      trackName = String(data.name);
      if (input.trackName && lower(input.trackName) !== lower(trackName)) {
        errors.push("track_name_mismatch");
      }
    }
  }

  type ApprovedDnaRow = {
    id: string;
    track_id?: string;
    short_pitch: string | null;
    approval_state: string;
    approved_lanes: string[] | null;
    excluded_lanes: string[] | null;
    primary_genre: string | null;
  };
  let approvedDna: ApprovedDnaRow | null = null;

  // Approved Song DNA is MANDATORY for automated playlist outreach.
  // No fallback to track_categories, short_pitch, pitch_angle, or genre inference.
  if (trackId && !errors.includes("track_id_not_found") && await tableExists(sb, "song_dna_versions")) {
    const currentApprovedId = trim(trackRow?.approved_song_dna_version_id);
    if (!currentApprovedId) {
      errors.push("missing_approved_song_dna");
    } else {
      const requestedId = songDnaVersionId || currentApprovedId;
      const { data } = await sb.from("song_dna_versions").select(
        "id, track_id, short_pitch, approval_state, approved_lanes, excluded_lanes, primary_genre",
      ).eq("id", requestedId).maybeSingle();

      if (!data) {
        errors.push("song_dna_not_found");
      } else if (String(data.track_id) !== trackId) {
        errors.push("song_dna_track_mismatch");
      } else if (String(data.approval_state) !== "approved") {
        errors.push("song_dna_not_approved");
      } else if (String(data.id) !== currentApprovedId) {
        errors.push("song_dna_not_current");
      } else {
        approvedDna = data as unknown as ApprovedDnaRow;
        songDnaVersionId = String(data.id);
      }
    }
  } else if (trackId && !errors.includes("track_id_not_found")) {
    errors.push("missing_approved_song_dna");
  }

  if (campaignId) {
    if (!(await tableExists(sb, "pitch_campaigns"))) {
      errors.push("campaign_table_missing");
    } else {
      const { data: camp } = await sb
        .from("pitch_campaigns")
        .select("id, track_id, status, song_dna_version_id")
        .eq("id", campaignId)
        .maybeSingle();
      if (!camp) {
        errors.push("campaign_not_found");
      } else {
        if (trackId && String(camp.track_id) !== trackId) errors.push("campaign_track_mismatch");
        const st = String(camp.status ?? "").toLowerCase();
        if (st && st !== "active" && st !== "live") errors.push("campaign_not_active");
      }
    }
  }

  let playlistRow: Record<string, unknown> | null = null;
  let targetVerificationStatus: string | null = null;
  if (playlistId) {
    const { data } = await sb
      .from("playlist_targets")
      .select(
        "playlist_id, lane, recommended_pitch_angle, playlist_name, curator_name, vibe_tags, verification_status, playlist_categories(category_id, categories(id, slug, label, family))",
      )
      .eq("playlist_id", playlistId)
      .maybeSingle();
    playlistRow = (data as Record<string, unknown> | null) ?? null;
    if (!playlistRow) {
      errors.push("playlist_not_found");
    } else {
      targetVerificationStatus = trim(playlistRow.verification_status) || null;
    }
  }

  const lanes = await loadLanesConfig(sb);

  // DNA-only pitch — refuse track/legacy carriers for automated outreach.
  const pitch: TrackPitchResult = resolveTrackPitchCopy({
    track: null,
    approvedDna,
    requireApprovedDna: true,
  });
  if (!pitch.ok) errors.push("missing_track_pitch_copy");

  const fitReason = resolveFitReason({
    row: playlistRow,
    lanes,
  });

  let compatible = true;
  let contradictionExplanation: string | null = null;
  let laneInApprovedSet: boolean | null = null;
  let laneInExcludedSet: boolean | null = null;
  let targetClassificationVerified = false;

  const lane = trim(input.lane) || trim(playlistRow?.lane);

  // Fail closed: null / empty lane cannot enter automated drafting.
  if (!lane) {
    compatible = false;
    contradictionExplanation =
      "Target lane/classification is null — unclassified targets cannot enter automated drafting.";
    errors.push("target_lane_null");
  } else if (!targetVerificationStatus || !VERIFIED_STATUSES.has(lower(targetVerificationStatus))) {
    compatible = false;
    contradictionExplanation =
      `Target classification is unverified (verification_status=${targetVerificationStatus ?? "null"}).`;
    errors.push("target_classification_unverified");
  } else {
    targetClassificationVerified = true;
  }

  if (approvedDna && lane) {
    const approved = new Set(
      (approvedDna.approved_lanes ?? []).map((s: string) => s.toLowerCase()),
    );
    const excluded = new Set(
      (approvedDna.excluded_lanes ?? []).map((s: string) => s.toLowerCase()),
    );
    const laneKey = lane.toLowerCase();
    laneInExcludedSet = excluded.has(laneKey);
    laneInApprovedSet = approved.size === 0 ? null : approved.has(laneKey);

    if (laneInExcludedSet) {
      compatible = false;
      contradictionExplanation =
        `Lane "${lane}" is on the approved Song DNA excluded_lanes list.`;
      errors.push("dna_excluded_lane");
    } else if (approved.size > 0 && !approved.has(laneKey)) {
      compatible = false;
      contradictionExplanation =
        `Lane "${lane}" is not in the approved Song DNA approved_lanes set.`;
      errors.push("dna_lane_not_approved");
    }
  }

  // Intentionally NO legacy categoryGate / trackGenre authorization path.
  // Missing DNA already failed closed above; categories retain display/analytics only.

  if (input.overrideCategoryCheck) {
    errors.push("override_forbidden");
    compatible = false;
  }

  const uniqueErrors = [...new Set(errors)];
  const allow = uniqueErrors.length === 0 && pitch.ok && compatible;
  const code = allow ? "allow" : (uniqueErrors[0] ?? "blocked");

  const decision: OutreachDecision = {
    allow,
    code,
    trackId: trackId || null,
    trackName: trackName || null,
    campaignId: campaignId || null,
    songDnaVersionId: songDnaVersionId || null,
    playlistId: playlistId || null,
    targetLane: lane || null,
    targetVerificationStatus,
    targetClassificationVerified,
    laneInApprovedSet,
    laneInExcludedSet,
    pitch,
    fitReason,
    copySource: pitch.ok ? pitch.source : null,
    actor: actorLabel,
    errors: uniqueErrors,
    compatible,
    contradictionExplanation,
    auditEvidence: {
      route: input.route,
      current_approved_song_dna_version_id: trackRow?.approved_song_dna_version_id ?? null,
      dna_primary_genre: approvedDna?.primary_genre ?? null,
      dna_approved_lanes: approvedDna?.approved_lanes ?? null,
      dna_excluded_lanes: approvedDna?.excluded_lanes ?? null,
      legacy_track_short_pitch_ignored: Boolean(trim(trackRow?.short_pitch)),
      legacy_track_pitch_angle_ignored: Boolean(trim(trackRow?.pitch_angle)),
      fit_reason_internal_only: fitReason.fitReason || null,
    },
  };

  await logDecision(sb, decision, { route: input.route, lane });
  return decision;
}

/** Draft-time helper: 422 payload when track pitch is missing. */
export function draftBlockedByPitch(
  decision: OutreachDecision,
  playlistId: string,
): { status: 422; data: Record<string, unknown> } | null {
  if (decision.pitch.ok) return null;
  return missingPitchCopyResult({
    trackName: decision.trackName ?? "",
    trackId: decision.trackId,
    playlistId,
    lane: decision.targetLane,
    missing: decision.pitch.ok ? undefined : decision.pitch.missing,
  });
}

/** Operational readiness report (no mutations). Alias kept for hub callers. */
export async function buildCutoverReadinessReport(
  sb: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { count: tracks } = await sb.from("tracks").select("*", { count: "exact", head: true });
  let approvedDna = 0;
  let pendingDna = 0;
  if (await tableExists(sb, "song_dna_versions")) {
    const a = await sb
      .from("song_dna_versions")
      .select("*", { count: "exact", head: true })
      .eq("approval_state", "approved");
    approvedDna = a.count ?? 0;
    const p = await sb
      .from("song_dna_versions")
      .select("*", { count: "exact", head: true })
      .in("approval_state", ["draft", "pending_fendi_review"]);
    pendingDna = p.count ?? 0;
  }
  const { count: pointed } = await sb
    .from("tracks")
    .select("*", { count: "exact", head: true })
    .not("approved_song_dna_version_id", "is", null);

  const { count: activeTargets } = await sb
    .from("playlist_targets")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);
  const { count: verifiedTargets } = await sb
    .from("playlist_targets")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .in("verification_status", [...VERIFIED_STATUSES]);
  const { count: nullLaneTargets } = await sb
    .from("playlist_targets")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .or("lane.is.null,lane.eq.");

  return {
    tracks: tracks ?? 0,
    approved_song_dna: approvedDna,
    pending_song_dna: pendingDna,
    tracks_with_current_approved_dna: pointed ?? 0,
    active_targets: activeTargets ?? 0,
    verified_classified_targets: verifiedTargets ?? 0,
    active_targets_null_lane: nullLaneTargets ?? 0,
    gate_mode: "enforce",
    dna_authority: "approved_song_dna_only",
    legacy_genre_authorization: false,
  };
}

/** @deprecated Use buildCutoverReadinessReport — kept for hub action name. */
export async function loadGateMode(_sb: SupabaseClient): Promise<"enforce"> {
  return "enforce";
}
