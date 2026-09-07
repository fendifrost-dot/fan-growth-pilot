/**
 * Fixed tool handlers for the claude_playlist_discovery remote MCP connector.
 * Tools call internal AGH logic under a fixed identity — never forward arbitrary
 * action names from the model.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  attributionFrom,
  can,
  denyUnlessCan,
  type OpsActor,
} from "./ops-actors.ts";
import { buildDiscoveryCapacityPlan } from "./discovery-capacity.ts";
import { enforceTrackDnaLaneEnvelope, resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import { resolveTrackPitchCopy } from "./pitch-copy.ts";
import {
  assertCopyAgainstDnaDescriptors,
  rejectCallerPlaylistCopy,
} from "./pitch-descriptor-guard.ts";
import { evaluateSubmissionPath } from "./multichannel-path.ts";
import { createHandoffBatch, addHandoffRecords } from "./handoff-queues.ts";
import { startDailyStationRun, completeDailyStationRun } from "./daily-ops.ts";
import { CLAUDE_STATION_IDS, isClaudeStationId } from "./chicago-time.ts";
import { stripSpoofedAttribution } from "./ops-actors.ts";

export type ToolResult = { status: number; data: Record<string, unknown> };

export const PLAYLIST_DISCOVERY_TOOLS = [
  "get_playlist_discovery_work",
  "submit_playlist_candidates",
  "create_playlist_draft_inventory",
  "start_claude_playlist_station",
  "complete_claude_playlist_station",
  "get_own_playlist_batches",
] as const;

export type PlaylistDiscoveryTool = (typeof PLAYLIST_DISCOVERY_TOOLS)[number];

export function isPlaylistDiscoveryTool(name: string): name is PlaylistDiscoveryTool {
  return (PLAYLIST_DISCOVERY_TOOLS as readonly string[]).includes(name);
}

/** Fixed identity — never accept caller-supplied actor labels. */
export function playlistDiscoveryActor(): OpsActor {
  return {
    kind: "claude_playlist_discovery",
    userId: null,
    label: "claude_playlist_discovery",
  };
}

function asActorReq(): { actor: null; req: Request } {
  // Handlers that take Request for credential resolution get a synthetic request
  // stamped with the discovery secret so resolveOpsActor yields the fixed identity
  // when the env secret is configured. MCP layer must set CLAUDE_PLAYLIST_DISCOVERY_SECRET.
  const secret = (Deno.env.get("CLAUDE_PLAYLIST_DISCOVERY_SECRET") || "").trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-claude-playlist-discovery-secret"] = secret;
  return { actor: null, req: new Request("https://agh.internal/mcp", { headers }) };
}

export async function getPlaylistDiscoveryWork(
  sb: SupabaseClient,
  ops: OpsActor,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "read_playlist_discovery_work");
  if (denied) return denied;

  // Active pitching tracks via campaigns — minimal projection (no ISRC / licensing).
  const { data: campaigns } = await sb
    .from("pitch_campaigns")
    .select("track_id, status")
    .eq("status", "active")
    .limit(50);
  const trackIds = [...new Set((campaigns ?? []).map((c) => String(c.track_id)).filter(Boolean))];

  const tracks: Record<string, unknown>[] = [];
  if (trackIds.length) {
    const { data: rows } = await sb
      .from("tracks")
      .select("id, name, approved_song_dna_version_id")
      .in("id", trackIds);
    for (const t of rows ?? []) {
      const trackId = String(t.id);
      const dna = await resolveCurrentApprovedDna(sb, { trackId });
      if (!dna.ok || !dna.songDnaVersionId) continue;
      const { data: dnaRow } = await sb
        .from("song_dna_versions")
        .select("id, short_pitch, primary_genre, approved_lanes, excluded_lanes, approval_state")
        .eq("id", dna.songDnaVersionId)
        .maybeSingle();
      tracks.push({
        track_id: trackId,
        title: t.name ?? null,
        approved_song_dna_version_id: dna.songDnaVersionId,
        allowed_lanes: dna.approvedLanes,
        excluded_lanes: dna.excludedLanes,
        approved_pitch_descriptors: dnaRow?.short_pitch ? [String(dnaRow.short_pitch)] : [],
        primary_genre: dnaRow?.primary_genre ?? null,
        // Explicitly omit ISRC / sample / licensing fields.
      });
    }
  }

  const { data: profiles } = await sb
    .from("discovery_profiles")
    .select("id, profile_key, label, genre_family, approved_lanes, is_active, approval_status")
    .eq("is_active", true)
    .eq("approval_status", "approved")
    .limit(40);

  let capacity: Record<string, unknown> = {};
  try {
    const plan = await buildDiscoveryCapacityPlan(sb, tracks.length || trackIds.length);
    capacity = {
      daily_raw_requirement: plan.daily_raw_requirement,
      effective_raw_target: plan.effective_raw_target,
      effective_verified_target: plan.effective_verified_target,
      active_pitching_songs: plan.active_pitching_songs,
    };
  } catch {
    capacity = { error: "capacity_unavailable" };
  }

  return {
    status: 200,
    data: {
      ok: true,
      actor: ops.label,
      tracks,
      discovery_profiles: (profiles ?? []).map((p) => ({
        id: p.id,
        profile_key: p.profile_key,
        label: p.label,
        genre_family: p.genre_family ?? null,
        approved_lanes: p.approved_lanes ?? [],
      })),
      daily_target: capacity,
    },
  };
}

export async function submitPlaylistCandidates(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "submit_playlist_candidates");
  if (denied) return denied;
  if (!can(ops, "verify_playlist_targets") || !can(ops, "research_playlist_targets")) {
    return { status: 403, data: { error: "missing research/verify capability" } };
  }

  const callerCopy = rejectCallerPlaylistCopy(body);
  if (callerCopy) return callerCopy;
  if (Boolean(body.override_category_check)) {
    return {
      status: 403,
      data: {
        error: "override_category_check is forbidden for claude_playlist_discovery",
        code: "override_forbidden",
      },
    };
  }

  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };
  const candidates = Array.isArray(clean.candidates) ? clean.candidates : [];
  if (!candidates.length) return { status: 400, data: { error: "candidates[] required" } };

  const dna = await resolveCurrentApprovedDna(sb, {
    trackId,
    callerSongDnaVersionId: clean.song_dna_version_id != null ? String(clean.song_dna_version_id) : null,
  });
  if (!dna.ok) {
    return {
      status: 422,
      data: { error: dna.errors[0] ?? "dna_rejected", code: dna.errors[0], errors: dna.errors },
    };
  }

  const attr = attributionFrom(ops);
  const accepted: Record<string, unknown>[] = [];
  const duplicates: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];

  for (const raw of candidates) {
    const c = typeof raw === "object" && raw ? stripSpoofedAttribution(raw as Record<string, unknown>) : {};
    // Never trust model verification/compatibility claims.
    delete c.verified;
    delete c.compatible;
    delete c.approved;
    delete c.actor_kind;
    delete c.discovered_by;

    const playlistId = String(c.playlist_id ?? c.spotify_playlist_id ?? "").trim();
    const playlistUrl = String(c.playlist_url ?? c.source_url ?? "").trim();
    const evidence = String(c.source_evidence ?? c.evidence ?? "").trim();
    const lane = String(c.lane ?? "").trim();
    const name = String(c.playlist_name ?? c.name ?? "").trim();

    if (!playlistId && !playlistUrl) {
      rejected.push({ reason: "missing_playlist_identity", candidate: c });
      continue;
    }
    if (!evidence) {
      rejected.push({ reason: "missing_source_evidence", playlist_id: playlistId || null });
      continue;
    }
    if (!lane) {
      rejected.push({ reason: "unknown_lane_fail_closed", playlist_id: playlistId || null });
      continue;
    }

    const id = playlistId || `url:${playlistUrl}`;
    const { data: existing } = await sb
      .from("playlist_targets")
      .select("playlist_id")
      .eq("playlist_id", id)
      .maybeSingle();
    if (existing) {
      duplicates.push({ playlist_id: id, reason: "duplicate_playlist_id" });
      continue;
    }

    // Path verification — server-side only.
    const path = await evaluateSubmissionPath({
      submission_channel: c.submission_channel != null ? String(c.submission_channel) : null,
      curator_email: c.curator_email != null ? String(c.curator_email) : null,
      form_url: c.form_url != null ? String(c.form_url) : null,
      form_source_evidence: evidence,
      ig_curator_account: c.ig_curator_account != null ? String(c.ig_curator_account) : null,
      ig_source_evidence: evidence,
      submission_url: playlistUrl || null,
    });

    // Insert first so DNA-lane envelope can resolve the target lane; roll back on reject.
    const row = {
      playlist_id: id,
      playlist_name: name || null,
      playlist_url: playlistUrl || null,
      lane,
      verification_status: path.path_verified ? path.status : "unverified",
      path_verified: path.path_verified,
      path_verification_notes: path.reason,
      curator_email: c.curator_email != null ? String(c.curator_email) : null,
      form_url: c.form_url != null ? String(c.form_url) : null,
      form_source_evidence: evidence,
      ig_curator_account: c.ig_curator_account != null ? String(c.ig_curator_account) : null,
      ig_source_evidence: evidence,
      contact_method: path.channel,
      submission_method: path.channel,
      discovered_by: attr.actor_kind,
      discovered_by_label: attr.actor_label,
      research_notes: evidence,
      updated_at: new Date().toISOString(),
    };

    const { error: insErr } = await sb.from("playlist_targets").insert(row);
    if (insErr) {
      if (String(insErr.message).includes("duplicate") || insErr.code === "23505") {
        duplicates.push({ playlist_id: id, reason: "duplicate_insert" });
        continue;
      }
      rejected.push({ playlist_id: id, reason: `insert_failed:${insErr.message}` });
      continue;
    }

    const laneCheck = await enforceTrackDnaLaneEnvelope(sb, {
      route: "submit_playlist_candidates",
      trackId,
      playlistId: id,
      callerSongDnaVersionId: dna.songDnaVersionId,
      actor: ops,
    });
    if (!laneCheck.ok) {
      await sb.from("playlist_targets").delete().eq("playlist_id", id);
      rejected.push({
        playlist_id: id,
        reason: laneCheck.errors[0] ?? "dna_lane_rejected",
        errors: laneCheck.errors,
      });
      continue;
    }

    accepted.push({
      playlist_id: id,
      lane,
      path_verified: path.path_verified,
      song_dna_version_id: dna.songDnaVersionId,
    });
  }

  return {
    status: 200,
    data: {
      ok: true,
      track_id: trackId,
      song_dna_version_id: dna.songDnaVersionId,
      accepted_count: accepted.length,
      duplicate_count: duplicates.length,
      rejected_count: rejected.length,
      accepted,
      duplicates,
      rejected,
      discovered_by: attr.actor_kind,
    },
  };
}

export async function createPlaylistDraftInventory(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "generate_playlist_drafts");
  if (denied) return denied;
  if (!can(ops, "create_handoff_batch")) {
    return { status: 403, data: { error: "create_handoff_batch required" } };
  }

  const callerCopy = rejectCallerPlaylistCopy(body);
  if (callerCopy) return callerCopy;
  if (Boolean(body.override_category_check)) {
    return {
      status: 403,
      data: {
        error: "override_category_check is forbidden for claude_playlist_discovery",
        code: "override_forbidden",
      },
    };
  }

  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  const candidateIds = Array.isArray(clean.accepted_candidate_ids)
    ? clean.accepted_candidate_ids.map(String)
    : Array.isArray(clean.playlist_ids)
    ? clean.playlist_ids.map(String)
    : [];
  if (!trackId || !candidateIds.length) {
    return { status: 400, data: { error: "track_id and accepted_candidate_ids required" } };
  }

  const dna = await resolveCurrentApprovedDna(sb, {
    trackId,
    callerSongDnaVersionId: clean.song_dna_version_id != null ? String(clean.song_dna_version_id) : null,
  });
  if (!dna.ok) {
    return {
      status: 422,
      data: { error: dna.errors[0] ?? "dna_rejected", code: dna.errors[0], errors: dna.errors },
    };
  }

  const { data: dnaRow } = await sb
    .from("song_dna_versions")
    .select("id, short_pitch, approval_state, primary_genre, approved_lanes, excluded_lanes")
    .eq("id", dna.songDnaVersionId!)
    .maybeSingle();
  const pitch = resolveTrackPitchCopy({ approvedDna: dnaRow, requireApprovedDna: true });
  if (!pitch.ok) {
    return { status: 422, data: { error: "missing approved Song DNA pitch copy", code: "missing_track_pitch_copy" } };
  }
  const descErr = assertCopyAgainstDnaDescriptors(pitch.pitch, {
    primary_genre: dnaRow?.primary_genre as string | null,
    approved_lanes: (dnaRow?.approved_lanes as string[]) ?? dna.approvedLanes,
    excluded_lanes: (dnaRow?.excluded_lanes as string[]) ?? dna.excludedLanes,
  });
  if (descErr) return { status: 422, data: { error: descErr, code: descErr } };

  const batchRes = await createHandoffBatch(
    sb,
    {
      batch_kind: "playlist",
      queue_state: "CLAUDE_BATCH_READY",
      track_id: trackId,
      song_dna_version_id: dna.songDnaVersionId,
    },
    ops,
  );
  if (batchRes.status >= 400) return batchRes;
  const batchId = String((batchRes.data.batch as { id?: string })?.id ?? "");
  if (!batchId) return { status: 500, data: { error: "batch create missing id" } };

  const records = [];
  for (const playlistId of candidateIds) {
    const envelope = await enforceTrackDnaLaneEnvelope(sb, {
      route: "create_playlist_draft_inventory",
      trackId,
      playlistId,
      callerSongDnaVersionId: dna.songDnaVersionId,
      actor: ops,
    });
    if (!envelope.ok) {
      return {
        status: 422,
        data: {
          error: envelope.errors[0] ?? "dna_lane_rejected",
          code: envelope.errors[0],
          playlist_id: playlistId,
          errors: envelope.errors,
        },
      };
    }
    records.push({
      record_kind: "playlist_target",
      track_id: trackId,
      playlist_target_id: playlistId,
      submission_channel: "email",
      song_dna_version_id: envelope.songDnaVersionId,
      queue_state: "CLAUDE_BATCH_READY",
      packet: {
        track_id: trackId,
        song_dna_version_id: envelope.songDnaVersionId,
        pitch: pitch.pitch,
        draft_body: pitch.pitch,
        pitch_copy_source: pitch.source,
      },
    });
  }

  const addRes = await addHandoffRecords(sb, { batch_id: batchId, records }, ops);
  if (addRes.status >= 400) return addRes;

  const attr = attributionFrom(ops);
  return {
    status: 200,
    data: {
      ok: true,
      batch_id: batchId,
      track_id: trackId,
      song_dna_version_id: dna.songDnaVersionId,
      draft_status: "pending",
      approved: false,
      sent: false,
      discovered_by: attr.actor_kind,
      drafted_by: attr.actor_kind,
      records: addRes.data,
    },
  };
}

export async function startClaudePlaylistStation(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "run_daily_station");
  if (denied) return denied;
  const stationId = String(body.station_id ?? "").trim();
  if (!isClaudeStationId(stationId)) {
    return {
      status: 403,
      data: {
        error: `claude_playlist_discovery may only start Claude stations: ${CLAUDE_STATION_IDS.join(", ")}`,
        code: "station_ownership",
      },
    };
  }
  const { req } = asActorReq();
  return startDailyStationRun(sb, body, null, req);
}

export async function completeClaudePlaylistStation(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "run_daily_station");
  if (denied) return denied;
  const { req } = asActorReq();
  // completeDailyStationRun loads station from DB and enforces ownership.
  return completeDailyStationRun(sb, body, null, req);
}

export async function getOwnPlaylistBatches(
  sb: SupabaseClient,
  ops: OpsActor,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  const denied = denyUnlessCan(ops, "read_own_playlist_batches");
  if (denied) return denied;
  const limit = Math.min(Number(body.limit) || 40, 100);
  const { data, error } = await sb
    .from("agh_handoff_batches")
    .select("id, batch_kind, queue_state, track_id, song_dna_version_id, record_count, discovered_by, drafted_by, business_date_ct, created_at, updated_at")
    .eq("discovered_by", "claude_playlist_discovery")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { status: 500, data: { error: error.message } };
  return {
    status: 200,
    data: {
      ok: true,
      rows: data ?? [],
      scoped_to: "claude_playlist_discovery",
    },
  };
}

export async function runPlaylistDiscoveryTool(
  tool: string,
  args: Record<string, unknown>,
  sb: SupabaseClient,
  ops: OpsActor = playlistDiscoveryActor(),
): Promise<ToolResult> {
  if (ops.kind !== "claude_playlist_discovery") {
    return {
      status: 403,
      data: { error: "playlist discovery tools require claude_playlist_discovery identity" },
    };
  }
  if (!isPlaylistDiscoveryTool(tool)) {
    return {
      status: 400,
      data: { error: `Unknown MCP tool: ${tool}`, code: "unknown_tool" },
    };
  }
  switch (tool) {
    case "get_playlist_discovery_work":
      return getPlaylistDiscoveryWork(sb, ops);
    case "submit_playlist_candidates":
      return submitPlaylistCandidates(sb, ops, args);
    case "create_playlist_draft_inventory":
      return createPlaylistDraftInventory(sb, ops, args);
    case "start_claude_playlist_station":
      return startClaudePlaylistStation(sb, ops, args);
    case "complete_claude_playlist_station":
      return completeClaudePlaylistStation(sb, ops, args);
    case "get_own_playlist_batches":
      return getOwnPlaylistBatches(sb, ops, args);
    default:
      return { status: 400, data: { error: `Unknown MCP tool: ${tool}`, code: "unknown_tool" } };
  }
}

