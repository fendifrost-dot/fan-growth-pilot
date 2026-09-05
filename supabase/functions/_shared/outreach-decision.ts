/**
 * Shared server-side outreach decision for draft + send paths.
 *
 * Always enforced (no shadow mode):
 *   - Exact track_id required (no title-only / guessed identity)
 *   - Playlist id required
 *   - Song-specific pitch copy required (track short_pitch / approved DNA short_pitch)
 *   - Playlist/lane copy never fills {{pitch}} (fit metadata only — not a template token)
 *   - If a song_dna_version_id is supplied, it must belong to the selected track and be approved
 *   - Genre/category fit: DNA lane rules when DNA present; categoryGate otherwise
 *   - Campaign id validated only when provided (pitch_campaigns may be absent)
 *   - General override_category_check is forbidden
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
import { categoryGate, targetGenre, trackGenre } from "./placement-match.ts";

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
      detail: { ...detail, errors: decision.errors },
    });
  } catch (e) {
    console.error("outreach decision log failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * One shared eligibility + copy decision for every operational route.
 * Always blocks on failure — no shadow/legacy bypass.
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

  if (!trackId) errors.push("missing_track_id");
  if (!playlistId) errors.push("missing_playlist_id");

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
      trackRow = data as {
        id: string;
        name: string;
        short_pitch: string | null;
        pitch_angle: string | null;
      };
      trackName = String(data.name);
      if (input.trackName && trim(input.trackName).toLowerCase() !== trackName.toLowerCase()) {
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

  // Song DNA is optional until Fendi has approved versions. When present, it governs.
  // A supplied song_dna_version_id MUST belong to the selected track (never another song's DNA).
  if (trackId && !errors.includes("track_id_not_found") && await tableExists(sb, "song_dna_versions")) {
    if (songDnaVersionId) {
      const { data } = await sb.from("song_dna_versions").select(
        "id, track_id, short_pitch, approval_state, approved_lanes, excluded_lanes, primary_genre",
      ).eq("id", songDnaVersionId).maybeSingle();
      if (!data) {
        errors.push("song_dna_not_found");
      } else if (String(data.track_id) !== trackId) {
        errors.push("song_dna_track_mismatch");
      } else if (String(data.approval_state) !== "approved") {
        errors.push("song_dna_not_approved");
      } else {
        approvedDna = data as unknown as ApprovedDnaRow;
        songDnaVersionId = String(data.id);
      }
    } else {
      const { data } = await sb.from("song_dna_versions").select(
        "id, track_id, short_pitch, approval_state, approved_lanes, excluded_lanes, primary_genre",
      ).eq("track_id", trackId).eq("approval_state", "approved").maybeSingle();
      if (data && String(data.approval_state) === "approved") {
        approvedDna = data as unknown as ApprovedDnaRow;
        songDnaVersionId = String(data.id);
      }
    }
  }

  // Campaign only when the table exists and an id was supplied.
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
  if (playlistId) {
    const { data } = await sb
      .from("playlist_targets")
      .select(
        "playlist_id, lane, recommended_pitch_angle, playlist_name, curator_name, vibe_tags, playlist_categories(category_id, categories(id, slug, label, family))",
      )
      .eq("playlist_id", playlistId)
      .maybeSingle();
    playlistRow = (data as Record<string, unknown> | null) ?? null;
  }

  let trackCategories: { id: string; slug: string; label: string }[] = [];
  let trackCatIds: string[] = [];
  if (trackId && !errors.includes("track_id_not_found")) {
    const { data: tCats } = await sb
      .from("track_categories")
      .select("category_id, categories(id, slug, label, family)")
      .eq("track_id", trackId);
    for (const tc of tCats ?? []) {
      const row = tc as unknown as {
        category_id?: string;
        categories?: { id: string; slug: string; label: string } | null;
      };
      const cat = row.categories;
      if (cat?.id) {
        trackCategories.push(cat);
        trackCatIds.push(String(row.category_id ?? cat.id));
      } else if (row.category_id) {
        trackCatIds.push(String(row.category_id));
      }
    }
  }

  const playlistCatIds = ((playlistRow?.playlist_categories ?? []) as {
    category_id: string;
    categories?: { id: string; slug: string; label: string } | null;
  }[]).map((pc) => String(pc.category_id));

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
      (approvedDna.approved_lanes ?? []).map((s: string) => s.toLowerCase()),
    );
    const excluded = new Set(
      (approvedDna.excluded_lanes ?? []).map((s: string) => s.toLowerCase()),
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

  // Genre/category fit when no approved DNA lane rules applied.
  // Without DNA, compare song categories / genre signals to the playlist (same
  // categoryGate used at draft time). With DNA, lane allow/exclude above is the fit check.
  if (
    !approvedDna &&
    compatible &&
    trackId &&
    playlistId &&
    !errors.includes("track_id_not_found")
  ) {
    const tGenre = trackGenre({
      categories: trackCategories,
      name: trackRow?.name ?? trackName,
      short_pitch: trackRow?.short_pitch ?? null,
      pitch_angle: trackRow?.pitch_angle ?? null,
    });
    const pGenre = targetGenre({
      lane: lane || null,
      playlist_name: playlistRow?.playlist_name as string | null,
      curator_name: playlistRow?.curator_name as string | null,
      vibe_tags: playlistRow?.vibe_tags,
    });
    const gate = categoryGate({
      trackCatIds,
      targetCatIds: playlistCatIds,
      trackGenre: tGenre,
      targetGenre: pGenre,
    });
    if (!gate.pass) {
      compatible = false;
      contradictionExplanation =
        contradictionExplanation ??
        `Category/genre gate failed (${gate.reason}).`;
      errors.push(gate.reason === "genre_conflict" ? "genre_conflict" : "category_mismatch");
    }
  }

  if (input.overrideCategoryCheck) {
    errors.push("override_forbidden");
    compatible = false;
  }

  const allow = errors.length === 0 && pitch.ok && compatible;
  const code = allow ? "allow" : (errors[0] ?? "blocked");

  const decision: OutreachDecision = {
    allow,
    code,
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
    lane: null,
    missing: decision.pitch.ok ? undefined : decision.pitch.missing,
  });
}

/** Operational readiness report (no mutations). */
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
  const { data: tracksMissingPitch } = await sb
    .from("tracks")
    .select("id, name, short_pitch, pitch_angle")
    .eq("status", "active");
  const missingPitch = (tracksMissingPitch ?? []).filter((t) => {
    const sp = String(t.short_pitch ?? "").trim();
    const pa = String(t.pitch_angle ?? "").trim();
    return !sp && !pa;
  });
  let activeCampaigns = 0;
  if (await tableExists(sb, "pitch_campaigns")) {
    const c = await sb
      .from("pitch_campaigns")
      .select("*", { count: "exact", head: true })
      .in("status", ["active", "live"]);
    activeCampaigns = c.count ?? 0;
  }
  const { count: legacyDrafts } = await sb
    .from("outreach_drafts")
    .select("*", { count: "exact", head: true })
    .is("track_id", null);
  let pendingProfiles = 0;
  let approvedProfiles = 0;
  if (await tableExists(sb, "discovery_profiles")) {
    const p = await sb
      .from("discovery_profiles")
      .select("*", { count: "exact", head: true })
      .eq("approval_status", "pending_fendi_review");
    pendingProfiles = p.count ?? 0;
    const a = await sb
      .from("discovery_profiles")
      .select("*", { count: "exact", head: true })
      .eq("approval_status", "approved");
    approvedProfiles = a.count ?? 0;
  }

  return {
    tracks: tracks ?? 0,
    approved_song_dna: approvedDna,
    pending_song_dna: pendingDna,
    active_tracks_missing_pitch_copy: missingPitch.map((t) => ({
      id: t.id,
      name: t.name,
    })),
    active_campaigns: activeCampaigns,
    legacy_drafts_without_track_id: legacyDrafts ?? 0,
    discovery_profiles_pending_fendi: pendingProfiles,
    discovery_profiles_approved: approvedProfiles,
    gate_mode: "enforce",
    operational:
      missingPitch.length === 0 ||
      (tracksMissingPitch ?? []).some((t) => String(t.short_pitch ?? "").trim() || String(t.pitch_angle ?? "").trim()),
  };
}

/** @deprecated Use buildCutoverReadinessReport — kept for hub action name. */
export async function loadGateMode(_sb: SupabaseClient): Promise<"enforce"> {
  return "enforce";
}
