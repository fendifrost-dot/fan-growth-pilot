/**
 * Shared server-side outreach decision for draft + send paths.
 *
 * Modes (artist_config.outreach_dna_gate_mode or env OUTREACH_DNA_GATE_MODE):
 *   - legacy  — current sender behavior (identity optional); still logs when possible
 *   - shadow  — compute full decision, log to outreach_decision_shadow_log, do NOT block
 *   - enforce — require track_id + approved DNA + campaign + playlist; block on failure
 *
 * Default: shadow (preserves live playlist submissions).
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

export type GateMode = "legacy" | "shadow" | "enforce";

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
};

export type OutreachDecision = {
  allow: boolean;
  code: string;
  mode: GateMode;
  trackId: string | null;
  trackName: string | null;
  campaignId: string | null;
  songDnaVersionId: string | null;
  playlistId: string | null;
  pitch: TrackPitchResult;
  fitReason: FitReasonResult;
  errors: string[];
  compatible: boolean;
  contradictionExplanation: string | null;
};

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function loadGateMode(sb: SupabaseClient): Promise<GateMode> {
  const env = (Deno.env.get("OUTREACH_DNA_GATE_MODE") || "").trim().toLowerCase();
  if (env === "legacy" || env === "shadow" || env === "enforce") return env;
  const { data } = await sb
    .from("artist_config")
    .select("value")
    .eq("key", "outreach_dna_gate_mode")
    .maybeSingle();
  const raw = data?.value;
  const v = typeof raw === "string"
    ? raw.replace(/^"|"$/g, "").toLowerCase()
    : typeof raw === "object" && raw !== null
    ? String(raw).toLowerCase()
    : String(raw ?? "shadow").replace(/^"|"$/g, "").toLowerCase();
  if (v === "legacy" || v === "enforce" || v === "shadow") return v as GateMode;
  return "shadow";
}

async function logShadow(
  sb: SupabaseClient,
  decision: OutreachDecision,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("outreach_decision_shadow_log").insert({
      route: detail.route ?? decision.code,
      mode: decision.mode,
      would_allow: decision.allow,
      decision_code: decision.code,
      track_id: decision.trackId,
      song_dna_version_id: decision.songDnaVersionId,
      campaign_id: decision.campaignId,
      playlist_id: decision.playlistId,
      detail: { ...detail, errors: decision.errors },
    });
  } catch (e) {
    console.error("shadow log failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * One shared eligibility + copy decision for every operational route.
 */
export async function evaluateOutreachDecision(
  sb: SupabaseClient,
  input: OutreachDecisionInput,
): Promise<OutreachDecision> {
  const mode = await loadGateMode(sb);
  const errors: string[] = [];
  const trackId = trim(input.trackId);
  const campaignId = trim(input.campaignId);
  const playlistId = trim(input.playlistId);
  let trackName = trim(input.trackName);
  let songDnaVersionId = trim(input.songDnaVersionId);

  // Reject title-only / guessed identity when enforcing or for shadow scoring
  if (!trackId) {
    errors.push("missing_track_id");
  }

  let trackRow: {
    id: string;
    name: string;
    short_pitch: string | null;
    pitch_angle: string | null;
  } | null = null;

  if (trackId) {
    const { data } = await sb
      .from("tracks")
      .select("id, name, short_pitch, pitch_angle")
      .eq("id", trackId)
      .maybeSingle();
    if (!data) {
      errors.push("track_id_not_found");
    } else {
      trackRow = data as typeof trackRow;
      trackName = String(data.name);
      if (input.trackName && trim(input.trackName).toLowerCase() !== trackName.toLowerCase()) {
        errors.push("track_name_mismatch");
      }
    }
  }

  let approvedDna: {
    id: string;
    short_pitch: string | null;
    approval_state: string;
    approved_lanes: string[] | null;
    excluded_lanes: string[] | null;
    primary_genre: string | null;
  } | null = null;

  if (trackId && !errors.includes("track_id_not_found")) {
    const q = songDnaVersionId
      ? sb.from("song_dna_versions").select(
        "id, short_pitch, approval_state, approved_lanes, excluded_lanes, primary_genre",
      ).eq("id", songDnaVersionId).maybeSingle()
      : sb.from("song_dna_versions").select(
        "id, short_pitch, approval_state, approved_lanes, excluded_lanes, primary_genre",
      ).eq("track_id", trackId).eq("approval_state", "approved").maybeSingle();
    const { data } = await q;
    if (data && String(data.approval_state) === "approved") {
      approvedDna = data as typeof approvedDna;
      songDnaVersionId = String(data.id);
    } else if (songDnaVersionId) {
      errors.push("song_dna_not_approved");
    } else {
      errors.push("missing_approved_song_dna");
    }
  }

  if (!campaignId) errors.push("missing_campaign_id");
  if (!playlistId) errors.push("missing_playlist_id");

  if (campaignId && trackId) {
    const { data: camp } = await sb
      .from("pitch_campaigns")
      .select("id, track_id, status, song_dna_version_id")
      .eq("id", campaignId)
      .maybeSingle();
    if (!camp) {
      errors.push("campaign_not_found");
    } else {
      if (String(camp.track_id) !== trackId) errors.push("campaign_track_mismatch");
      const st = String(camp.status ?? "").toLowerCase();
      if (st && st !== "active" && st !== "live") errors.push("campaign_not_active");
    }
  }

  // Playlist row for fit reason + lane contradiction
  let playlistRow: Record<string, unknown> | null = null;
  if (playlistId) {
    const { data } = await sb
      .from("playlist_targets")
      .select("playlist_id, lane, recommended_pitch_angle")
      .eq("playlist_id", playlistId)
      .maybeSingle();
    playlistRow = (data as Record<string, unknown> | null) ?? null;
  }

  const lanes = await loadLanesConfig(sb);
  const pitch = resolveTrackPitchCopy({ track: trackRow, approvedDna });
  if (!pitch.ok) errors.push("missing_track_pitch_copy");

  const fitReason = resolveFitReason({
    row: playlistRow,
    lanes,
  });

  let compatible = true;
  let contradictionExplanation: string | null = null;
  const lane = trim(input.lane) || trim(playlistRow?.lane);
  if (approvedDna && lane) {
    const approved = new Set(
      (approvedDna.approved_lanes ?? []).map((s) => s.toLowerCase()),
    );
    const excluded = new Set(
      (approvedDna.excluded_lanes ?? []).map((s) => s.toLowerCase()),
    );
    if (excluded.has(lane.toLowerCase())) {
      compatible = false;
      contradictionExplanation =
        `Lane "${lane}" is on the approved Song DNA excluded_lanes list.`;
      errors.push("dna_excluded_lane");
    } else if (approved.size > 0 && !approved.has(lane.toLowerCase())) {
      compatible = false;
      contradictionExplanation =
        `Lane "${lane}" is not in the approved Song DNA approved_lanes set.`;
      errors.push("dna_lane_not_approved");
    }
  }

  // Category override — Fendi-only, reason required, audited
  if (input.overrideCategoryCheck) {
    if (!input.isFendiAdmin || !trim(input.overrideReason) || !trim(input.overrideActorUserId)) {
      errors.push("override_forbidden");
      compatible = false;
    } else if (
      trackId && songDnaVersionId && campaignId && playlistId && trim(input.overrideReason)
    ) {
      await sb.from("outreach_mismatch_overrides").insert({
        track_id: trackId,
        song_dna_version_id: songDnaVersionId,
        campaign_id: campaignId,
        playlist_id: playlistId,
        reason: trim(input.overrideReason),
        actor_user_id: trim(input.overrideActorUserId),
      });
      // Strip lane contradiction errors for this scoped override only
      const filtered = errors.filter((e) =>
        e !== "dna_excluded_lane" && e !== "dna_lane_not_approved"
      );
      errors.length = 0;
      errors.push(...filtered);
      compatible = true;
      contradictionExplanation = null;
    }
  }

  const hardErrors = errors.filter((e) => e !== "missing_approved_song_dna" || mode === "enforce");
  // In shadow/legacy, missing DNA is scored but legacy send may continue
  const enforceErrors = mode === "enforce"
    ? errors
    : errors.filter((e) =>
      [
        "track_name_mismatch",
        "override_forbidden",
      ].includes(e)
    );

  const allow = mode === "enforce"
    ? errors.length === 0 && pitch.ok && compatible
    : mode === "shadow"
    ? true // never block current sender
    : true;

  const code = allow
    ? (errors.length ? "shadow_would_block" : "allow")
    : errors[0] ?? "blocked";

  const decision: OutreachDecision = {
    allow: mode === "enforce" ? (errors.length === 0 && pitch.ok && compatible) : true,
    code,
    mode,
    trackId: trackId || null,
    trackName: trackName || null,
    campaignId: campaignId || null,
    songDnaVersionId: songDnaVersionId || null,
    playlistId: playlistId || null,
    pitch,
    fitReason,
    errors,
    compatible,
    contradictionExplanation,
  };

  if (mode === "shadow" || mode === "enforce") {
    await logShadow(sb, decision, {
      route: input.route,
      hardErrors,
      enforceErrors,
      lane,
    });
  }

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
    lane: null,
    missing: decision.pitch.ok ? undefined : decision.pitch.missing,
  });
}

/** Cutover readiness report (no mutations). */
export async function buildCutoverReadinessReport(
  sb: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { count: tracks } = await sb.from("tracks").select("*", { count: "exact", head: true });
  const { count: approvedDna } = await sb
    .from("song_dna_versions")
    .select("*", { count: "exact", head: true })
    .eq("approval_state", "approved");
  const { count: pendingDna } = await sb
    .from("song_dna_versions")
    .select("*", { count: "exact", head: true })
    .in("approval_state", ["draft", "pending_fendi_review"]);
  const { data: tracksMissingPitch } = await sb
    .from("tracks")
    .select("id, name, short_pitch, pitch_angle")
    .eq("status", "active");
  const missingPitch = (tracksMissingPitch ?? []).filter((t) => {
    const sp = String(t.short_pitch ?? "").trim();
    const pa = String(t.pitch_angle ?? "").trim();
    return !sp && !pa;
  });
  const { count: activeCampaigns } = await sb
    .from("pitch_campaigns")
    .select("*", { count: "exact", head: true })
    .in("status", ["active", "live"]);
  const { count: legacyDrafts } = await sb
    .from("outreach_drafts")
    .select("*", { count: "exact", head: true })
    .is("track_id", null);
  const { count: pendingProfiles } = await sb
    .from("discovery_profiles")
    .select("*", { count: "exact", head: true })
    .eq("approval_status", "pending_fendi_review");
  const { count: approvedProfiles } = await sb
    .from("discovery_profiles")
    .select("*", { count: "exact", head: true })
    .eq("approval_status", "approved");

  return {
    tracks: tracks ?? 0,
    approved_song_dna: approvedDna ?? 0,
    pending_song_dna: pendingDna ?? 0,
    active_tracks_missing_pitch_copy: missingPitch.map((t) => ({
      id: t.id,
      name: t.name,
    })),
    active_campaigns: activeCampaigns ?? 0,
    legacy_drafts_without_track_id: legacyDrafts ?? 0,
    discovery_profiles_pending_fendi: pendingProfiles ?? 0,
    discovery_profiles_approved: approvedProfiles ?? 0,
    gate_mode: await loadGateMode(sb),
    ready_for_enforce:
      (approvedDna ?? 0) > 0 &&
      (activeCampaigns ?? 0) > 0 &&
      missingPitch.length === 0 &&
      (legacyDrafts ?? 0) === 0,
  };
}
