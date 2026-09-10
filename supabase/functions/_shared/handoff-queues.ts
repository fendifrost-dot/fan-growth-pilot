/**
 * Durable Claude → Grok handoff queue states.
 * Attribution is always stamped from authenticated identity — never from body.
 *
 * Authority (fail-closed):
 *   Claude / service / scheduler — Claude-side states only
 *   Grok / Fendi — review / approve / reject / import
 *   Human admin — cannot approve or reject as final authority
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  can,
  resolveOpsActor,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";
import { chicagoBusinessDate } from "./chicago-time.ts";
import { enforceTrackDnaLaneEnvelope, resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import {
  assertCopyAgainstDnaDescriptors,
  rejectCallerPlaylistCopy,
} from "./pitch-descriptor-guard.ts";
import { resolveTrackPitchCopy } from "./pitch-copy.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const HANDOFF_QUEUE_STATES = [
  "CLAUDE_BATCH_READY",
  "CLAUDE_PLAYLIST_COMPLETE",
  "AWAITING_GROK_REVIEW",
  "GROK_REVIEWED",
  "APPROVED_FOR_SEND",
  "REJECTED_BY_GROK",
  "AWAITING_AGH_IMPORT",
  "IMPORTED_TO_AGH",
] as const;

export type HandoffQueueState = (typeof HANDOFF_QUEUE_STATES)[number];

export const HANDOFF_ACTIONS = [
  "create_handoff_batch",
  "add_handoff_records",
  "advance_handoff_batch",
  "advance_claude_ready_batches",
  "review_handoff_batch",
  "list_handoff_batches",
  "get_handoff_batch",
  "mark_manual_form_submitted",
  "mark_manual_ig_dm_submitted",
] as const;

export function isHandoffAction(action: string): boolean {
  return (HANDOFF_ACTIONS as readonly string[]).includes(action);
}

export function isHandoffQueueState(v: string): v is HandoffQueueState {
  return (HANDOFF_QUEUE_STATES as readonly string[]).includes(v);
}

/** Claude-side states only — never approval / send / import. */
export const CLAUDE_SIDE_STATES = new Set<HandoffQueueState>([
  "CLAUDE_BATCH_READY",
  "CLAUDE_PLAYLIST_COMPLETE",
  "AWAITING_GROK_REVIEW",
]);

/** Final authority states — Grok or Fendi only. */
export const FINAL_AUTHORITY_STATES = new Set<HandoffQueueState>([
  "GROK_REVIEWED",
  "APPROVED_FOR_SEND",
  "REJECTED_BY_GROK",
  "AWAITING_AGH_IMPORT",
  "IMPORTED_TO_AGH",
]);

/** Allowed single-step transitions — strict ordered playlist chain (no shortcuts). */
export const HANDOFF_TRANSITIONS: Record<HandoffQueueState, readonly HandoffQueueState[]> = {
  CLAUDE_BATCH_READY: ["CLAUDE_PLAYLIST_COMPLETE"],
  CLAUDE_PLAYLIST_COMPLETE: ["AWAITING_GROK_REVIEW"],
  AWAITING_GROK_REVIEW: ["GROK_REVIEWED"],
  GROK_REVIEWED: ["APPROVED_FOR_SEND", "REJECTED_BY_GROK"],
  APPROVED_FOR_SEND: ["AWAITING_AGH_IMPORT"],
  REJECTED_BY_GROK: [],
  AWAITING_AGH_IMPORT: ["IMPORTED_TO_AGH"],
  IMPORTED_TO_AGH: [],
};

const KNOWN_CHANNELS = new Set(["email", "web_form", "instagram_dm"]);

export function assertKnownChannel(channel: string | null | undefined): string | null {
  if (channel == null || channel === "") return null;
  const c = String(channel).trim().toLowerCase();
  if (!KNOWN_CHANNELS.has(c)) {
    return `Unknown submission channel "${channel}" — fail closed (allowed: email, web_form, instagram_dm)`;
  }
  return null;
}

export function canTransitionHandoff(
  from: HandoffQueueState,
  to: HandoffQueueState,
): boolean {
  if (from === to) return true;
  return HANDOFF_TRANSITIONS[from].includes(to);
}

/** Who may set a target queue state (create or advance). */
export function authorizeHandoffState(
  ops: OpsActor,
  state: HandoffQueueState,
): string | null {
  if (CLAUDE_SIDE_STATES.has(state)) {
    if (
      can(ops, "create_handoff_batch") ||
      can(ops, "review_handoff_batch") ||
      can(ops, "approve_playlist_drafts")
    ) {
      return null;
    }
    return `${ops.label} cannot set Claude-side handoff states`;
  }

  // Final authority — never Claude, playlist-discovery, service, scheduler, or human_admin alone.
  if (
    ops.kind === "claude" ||
    ops.kind === "claude_playlist_discovery" ||
    ops.kind === "service" ||
    ops.kind === "scheduler"
  ) {
    return `${ops.label} cannot set final review/approval/send/import states`;
  }
  if (ops.kind === "human_admin") {
    return "human_admin cannot approve or reject handoff batches as final authority";
  }

  if (state === "APPROVED_FOR_SEND") {
    if (!can(ops, "approve_playlist_drafts")) {
      return `${ops.label} cannot approve handoff batches`;
    }
    return null;
  }
  if (state === "REJECTED_BY_GROK") {
    if (!can(ops, "reject_playlist_drafts")) {
      return `${ops.label} cannot reject handoff batches`;
    }
    return null;
  }
  // GROK_REVIEWED / import states
  if (!can(ops, "review_handoff_batch") && !can(ops, "approve_playlist_drafts")) {
    return `${ops.label} cannot set ${state}`;
  }
  return null;
}

function stampDiscover(ops: OpsActor): Record<string, string | null> {
  const a = attributionFrom(ops);
  return {
    discovered_by: a.actor_kind,
    discovered_by_label: a.actor_label,
  };
}

function stampDraft(ops: OpsActor): Record<string, string | null> {
  const a = attributionFrom(ops);
  return {
    drafted_by: a.actor_kind,
    drafted_by_label: a.actor_label,
  };
}

function stampReview(ops: OpsActor): Record<string, string | null> {
  const a = attributionFrom(ops);
  return {
    reviewed_by: a.actor_kind,
    reviewed_by_label: a.actor_label,
  };
}

function stampApprove(ops: OpsActor): Record<string, string | null> {
  const a = attributionFrom(ops);
  return {
    approved_by: a.actor_kind,
    approved_by_label: a.actor_label,
  };
}

function stampReject(ops: OpsActor): Record<string, string | null> {
  const a = attributionFrom(ops);
  return {
    rejected_by: a.actor_kind,
    rejected_by_label: a.actor_label,
  };
}

async function recountBatchRecords(sb: SupabaseClient, batchId: string): Promise<number> {
  const { count, error } = await sb
    .from("agh_handoff_records")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId);
  if (error) return 0;
  const n = count ?? 0;
  await sb
    .from("agh_handoff_batches")
    .update({ record_count: n, updated_at: new Date().toISOString() })
    .eq("id", batchId);
  return n;
}

/** Require approved Song DNA for form/DM handoff packets. */
export async function requireApprovedSongDna(
  sb: SupabaseClient,
  songDnaVersionId: string | null | undefined,
): Promise<string | null> {
  const id = (songDnaVersionId ?? "").trim();
  if (!id) {
    return "song_dna_version_id required — form/DM cannot bypass Song-DNA enforcement";
  }
  const { data, error } = await sb
    .from("song_dna_versions")
    .select("id, approval_state")
    .eq("id", id)
    .maybeSingle();
  if (error) return `song DNA lookup failed: ${error.message}`;
  if (!data) return "song_dna_version_id not found";
  if (String(data.approval_state) !== "approved") {
    return `song DNA must be approved (got ${data.approval_state})`;
  }
  return null;
}

function unscopedHandoffReader(ops: OpsActor): boolean {
  return ops.kind === "fendi" || ops.kind === "human_admin" || ops.kind === "grok_playlist_control";
}

export async function createHandoffBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const clean = stripSpoofedAttribution(body);
  const batchKind = String(clean.batch_kind ?? "playlist").trim();
  if (batchKind !== "playlist" && batchKind !== "sync") {
    return { status: 400, data: { error: "batch_kind must be playlist|sync" } };
  }
  const queueState = String(clean.queue_state ?? "CLAUDE_BATCH_READY").trim();
  if (!isHandoffQueueState(queueState)) {
    return { status: 400, data: { error: `Invalid queue_state` } };
  }
  // New batches must start on Claude side — never pre-approved.
  if (!CLAUDE_SIDE_STATES.has(queueState)) {
    return {
      status: 403,
      data: {
        error: "New handoff batches must start in a Claude-side state (not approved/rejected/imported)",
        code: "invalid_initial_state",
      },
    };
  }
  const authErr = authorizeHandoffState(ops, queueState);
  if (authErr) return { status: 403, data: { error: authErr } };

  const trackId = clean.track_id != null ? String(clean.track_id).trim() : "";
  let resolvedDnaId: string | null = null;
  if (batchKind === "playlist") {
    if (!trackId) {
      return { status: 422, data: { error: "track_id required for playlist handoff batches", code: "missing_track_id" } };
    }
    const resolved = await resolveCurrentApprovedDna(sb, {
      trackId,
      callerSongDnaVersionId: clean.song_dna_version_id != null ? String(clean.song_dna_version_id) : null,
    });
    if (!resolved.ok) {
      return {
        status: 422,
        data: { error: resolved.errors[0] ?? "dna_rejected", code: resolved.errors[0], errors: resolved.errors },
      };
    }
    resolvedDnaId = resolved.songDnaVersionId;
  }

  const discover = stampDiscover(ops);
  const row = {
    batch_kind: batchKind,
    queue_state: queueState,
    business_date_ct:
      typeof clean.business_date_ct === "string"
        ? clean.business_date_ct
        : chicagoBusinessDate(),
    station_run_id: clean.station_run_id ? String(clean.station_run_id) : null,
    upstream_batch_id: clean.upstream_batch_id ? String(clean.upstream_batch_id) : null,
    track_id: trackId || null,
    // Server-resolved current approved DNA only — never a foreign/stale caller UUID.
    song_dna_version_id: resolvedDnaId,
    discovery_profile_ids: Array.isArray(clean.discovery_profile_ids)
      ? clean.discovery_profile_ids.map(String)
      : [],
    notes: clean.notes != null ? String(clean.notes) : null,
    payload: typeof clean.payload === "object" && clean.payload ? clean.payload : {},
    record_count: 0,
    ...discover,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb.from("agh_handoff_batches").insert(row).select().single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, batch: data } };
}

export async function addHandoffRecords(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const clean = stripSpoofedAttribution(body);
  const batchId = String(clean.batch_id ?? "").trim();
  if (!batchId) return { status: 400, data: { error: "batch_id required" } };
  const records = Array.isArray(clean.records) ? clean.records : [];
  if (!records.length) return { status: 400, data: { error: "records[] required" } };

  const { data: batch } = await sb
    .from("agh_handoff_batches")
    .select("id, discovered_by, song_dna_version_id, track_id, batch_kind")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { status: 404, data: { error: "batch not found" } };
  if (
    !unscopedHandoffReader(ops) &&
    batch.discovered_by &&
    batch.discovered_by !== ops.kind
  ) {
    return { status: 403, data: { error: "Cannot add records to another actor's batch" } };
  }

  const discover = stampDiscover(ops);
  const rows: Record<string, unknown>[] = [];
  for (const raw of records) {
    const r = stripSpoofedAttribution(
      typeof raw === "object" && raw ? (raw as Record<string, unknown>) : {},
    );
    const channel = r.submission_channel != null ? String(r.submission_channel) : null;
    const channelErr = assertKnownChannel(channel);
    if (channelErr) return { status: 422, data: { error: channelErr, code: "unknown_channel" } };

    const trackId = String(r.track_id ?? batch.track_id ?? "").trim();
    const playlistId = r.playlist_target_id != null ? String(r.playlist_target_id) : "";

    // Playlist form/DM/email handoff records must carry track_id and pass lane envelope.
    if (batch.batch_kind === "playlist" || channel === "web_form" || channel === "instagram_dm" || channel === "email") {
      if (!trackId) {
        return { status: 422, data: { error: "track_id required on every playlist handoff record", code: "missing_track_id" } };
      }
      if (!playlistId) {
        return { status: 422, data: { error: "playlist_target_id required", code: "missing_playlist_id" } };
      }
      const envelope = await enforceTrackDnaLaneEnvelope(sb, {
        route: "add_handoff_records",
        trackId,
        playlistId,
        callerSongDnaVersionId: r.song_dna_version_id != null ? String(r.song_dna_version_id) : null,
        actor: ops,
      });
      if (!envelope.ok) {
        return {
          status: 422,
          data: {
            error: envelope.errors[0] ?? "dna_lane_rejected",
            code: envelope.errors[0] ?? "dna_lane_rejected",
            errors: envelope.errors,
          },
        };
      }

      // Reject caller-written playlist pitch copy on the record payload.
      const callerCopy = rejectCallerPlaylistCopy(r);
      if (callerCopy) return callerCopy;
      if (typeof r.packet === "object" && r.packet) {
        const pktCopy = rejectCallerPlaylistCopy(r.packet as Record<string, unknown>);
        if (pktCopy) return pktCopy;
      }

      const { data: dnaRow } = await sb
        .from("song_dna_versions")
        .select("id, short_pitch, approval_state, primary_genre, approved_lanes, excluded_lanes")
        .eq("id", envelope.songDnaVersionId!)
        .maybeSingle();
      const pitch = resolveTrackPitchCopy({
        approvedDna: dnaRow,
        requireApprovedDna: true,
      });
      if (!pitch.ok) {
        return {
          status: 422,
          data: { error: "missing approved Song DNA pitch copy", code: "missing_track_pitch_copy" },
        };
      }
      const descErr = assertCopyAgainstDnaDescriptors(pitch.pitch, {
        primary_genre: dnaRow?.primary_genre as string | null,
        approved_lanes: (dnaRow?.approved_lanes as string[]) ?? envelope.approvedLanes,
        excluded_lanes: (dnaRow?.excluded_lanes as string[]) ?? envelope.excludedLanes,
      });
      if (descErr) {
        return { status: 422, data: { error: descErr, code: descErr, persisted: false } };
      }

      const recordState = String(r.queue_state ?? "CLAUDE_BATCH_READY");
      if (!isHandoffQueueState(recordState) || !CLAUDE_SIDE_STATES.has(recordState)) {
        return {
          status: 403,
          data: { error: "Handoff records must enter in a Claude-side state", code: "invalid_record_state" },
        };
      }

      const packet = typeof r.packet === "object" && r.packet ? { ...(r.packet as Record<string, unknown>) } : {};
      // Strip any caller playlist copy fields — server DNA pitch only.
      for (const k of [
        "draft_body", "body", "subject", "override_body", "override_subject",
        "email_body", "pitch_body", "ig_dm_draft", "pitch",
      ]) {
        delete packet[k];
      }
      packet.track_id = trackId;
      packet.song_dna_version_id = envelope.songDnaVersionId;
      packet.pitch = pitch.pitch;
      packet.draft_body = pitch.pitch;
      packet.pitch_copy_source = pitch.source;
      // Never persist playlist_targets.song_dna_version_id as authoritative.
      delete packet.playlist_target_song_dna_version_id;

      rows.push({
        batch_id: batchId,
        record_kind: String(r.record_kind ?? "playlist_target"),
        queue_state: recordState,
        track_id: trackId,
        playlist_target_id: playlistId,
        outreach_draft_id: r.outreach_draft_id != null ? String(r.outreach_draft_id) : null,
        sync_target_id: r.sync_target_id != null ? String(r.sync_target_id) : null,
        sync_opportunity_id: r.sync_opportunity_id != null ? String(r.sync_opportunity_id) : null,
        submission_channel: channel,
        dedupe_key: r.dedupe_key != null ? String(r.dedupe_key) : null,
        song_dna_version_id: envelope.songDnaVersionId,
        packet,
        ...discover,
        updated_at: new Date().toISOString(),
      });
      continue;
    }

    const recordState = String(r.queue_state ?? "CLAUDE_BATCH_READY");
    if (!isHandoffQueueState(recordState) || !CLAUDE_SIDE_STATES.has(recordState)) {
      return {
        status: 403,
        data: { error: "Handoff records must enter in a Claude-side state", code: "invalid_record_state" },
      };
    }

    rows.push({
      batch_id: batchId,
      record_kind: String(r.record_kind ?? "playlist_target"),
      queue_state: recordState,
      track_id: trackId || null,
      playlist_target_id: playlistId || null,
      outreach_draft_id: r.outreach_draft_id != null ? String(r.outreach_draft_id) : null,
      sync_target_id: r.sync_target_id != null ? String(r.sync_target_id) : null,
      sync_opportunity_id: r.sync_opportunity_id != null ? String(r.sync_opportunity_id) : null,
      submission_channel: channel,
      dedupe_key: r.dedupe_key != null ? String(r.dedupe_key) : null,
      song_dna_version_id: null,
      packet: typeof r.packet === "object" && r.packet ? r.packet : {},
      ...discover,
      updated_at: new Date().toISOString(),
    });
  }

  let inserted = 0;
  let duplicates = 0;
  const outRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    const { data: one, error: e1 } = await sb
      .from("agh_handoff_records")
      .insert(row)
      .select()
      .maybeSingle();
    if (e1) {
      if (String(e1.message).includes("duplicate") || e1.code === "23505") {
        duplicates++;
        continue;
      }
      return { status: 500, data: { error: e1.message } };
    }
    if (one) {
      inserted++;
      outRows.push(one);
    }
  }

  const recordCount = await recountBatchRecords(sb, batchId);
  return {
    status: 200,
    data: { ok: true, inserted, duplicates, record_count: recordCount, rows: outRows },
  };
}

export async function advanceHandoffBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const clean = stripSpoofedAttribution(body);
  const batchId = String(clean.batch_id ?? "").trim();
  const next = String(clean.queue_state ?? "").trim();
  if (!batchId || !isHandoffQueueState(next)) {
    return { status: 400, data: { error: "batch_id and valid queue_state required" } };
  }

  const authErr = authorizeHandoffState(ops, next);
  if (authErr) return { status: 403, data: { error: authErr, code: "authority_denied" } };

  const { data: existing, error: loadErr } = await sb
    .from("agh_handoff_batches")
    .select("*")
    .eq("id", batchId)
    .maybeSingle();
  if (loadErr) return { status: 500, data: { error: loadErr.message } };
  if (!existing) return { status: 404, data: { error: "batch not found" } };

  const from = String(existing.queue_state) as HandoffQueueState;
  if (!isHandoffQueueState(from) || !canTransitionHandoff(from, next)) {
    return {
      status: 422,
      data: {
        error: `Illegal handoff transition ${from} → ${next}`,
        code: "illegal_transition",
        from,
        to: next,
        allowed: isHandoffQueueState(from) ? [...HANDOFF_TRANSITIONS[from]] : [],
      },
    };
  }
  // Idempotent same-state is ok; otherwise must be a real forward step.
  if (from === next) {
    return { status: 200, data: { ok: true, batch: existing, noop: true } };
  }

  const stamps: Record<string, string> = {};
  if (next === "CLAUDE_PLAYLIST_COMPLETE" || next === "AWAITING_GROK_REVIEW") {
    Object.assign(stamps, stampDraft(ops));
  }
  if (FINAL_AUTHORITY_STATES.has(next)) Object.assign(stamps, stampReview(ops));
  if (next === "APPROVED_FOR_SEND") Object.assign(stamps, stampApprove(ops));
  if (next === "REJECTED_BY_GROK") {
    Object.assign(stamps, stampReject(ops));
    if (clean.rejection_reason != null) stamps.notes = String(clean.rejection_reason);
  }

  // Prefer atomic Postgres RPC (compare-and-set on batch_id + expected state).
  // Stamps never overwrite discovered_by / discovered_by_label (create-time only).
  // No non-atomic application fallback — fail closed if RPC is unavailable.
  const { data: rpcData, error: rpcErr } = await sb.rpc("advance_agh_handoff_batch", {
    p_batch_id: batchId,
    p_expected_state: from,
    p_next_state: next,
    p_stamps: stamps,
  });

  if (rpcErr) {
    const msg = String(rpcErr.message || "");
    const unavailable =
      /could not find the function/i.test(msg) ||
      /permission denied/i.test(msg) ||
      /42501/.test(msg) ||
      rpcErr.code === "PGRST202" ||
      rpcErr.code === "42883";
    return {
      status: unavailable ? 503 : 500,
      data: {
        error: unavailable
          ? "advance_agh_handoff_batch RPC unavailable — fail closed (no non-atomic fallback)"
          : `advance_agh_handoff_batch RPC failed: ${msg}`,
        code: unavailable ? "rpc_unavailable" : "rpc_failed",
      },
    };
  }

  if (rpcData && typeof rpcData === "object") {
    const result = rpcData as Record<string, unknown>;
    if (result.ok === false && result.code === "conflict") {
      return {
        status: 409,
        data: {
          error: String(result.error ?? "conflict"),
          code: "conflict",
          expected: from,
          attempted: next,
        },
      };
    }
    if (result.ok === true) {
      return {
        status: 200,
        data: {
          ok: true,
          batch: result.batch,
          records_updated: result.records_updated,
          atomic: true,
        },
      };
    }
    if (result.ok === false) {
      return {
        status: 422,
        data: {
          error: String(result.error ?? "advance_failed"),
          code: String(result.code ?? "advance_failed"),
        },
      };
    }
  }

  return {
    status: 503,
    data: {
      error: "advance_agh_handoff_batch returned no result — fail closed",
      code: "rpc_unavailable",
    },
  };
}

export async function reviewHandoffBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  // Hard gate: review_handoff_batch required (not merely review_playlist_drafts).
  if (!can(ops, "review_handoff_batch") && !can(ops, "approve_playlist_drafts")) {
    return { status: 403, data: { error: `${ops.label} cannot review handoff batches` } };
  }
  if (
    ops.kind === "claude" ||
    ops.kind === "claude_playlist_discovery" ||
    ops.kind === "service" ||
    ops.kind === "human_admin"
  ) {
    return { status: 403, data: { error: `${ops.label} cannot act as final handoff authority` } };
  }
  const clean = stripSpoofedAttribution(body);
  const decision = String(clean.decision ?? "").trim().toLowerCase();
  let next: HandoffQueueState = "GROK_REVIEWED";
  if (decision === "approve") {
    if (!can(ops, "approve_playlist_drafts")) {
      return { status: 403, data: { error: `${ops.label} cannot approve handoff batches` } };
    }
    // Strict chain: must already be GROK_REVIEWED before APPROVED_FOR_SEND.
    next = "APPROVED_FOR_SEND";
  } else if (decision === "reject") {
    if (!can(ops, "reject_playlist_drafts")) {
      return { status: 403, data: { error: `${ops.label} cannot reject handoff batches` } };
    }
    next = "REJECTED_BY_GROK";
  } else if (decision === "reviewed" || decision === "") {
    next = "GROK_REVIEWED";
  }
  return advanceHandoffBatch(sb, { ...clean, queue_state: next }, ops);
}

export async function markManualFormSubmitted(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  return markManualHandoffSubmission(sb, body, ops, "web_form");
}

export async function markManualIgDmSubmitted(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  return markManualHandoffSubmission(sb, body, ops, "instagram_dm");
}

async function markManualHandoffSubmission(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
  channel: "web_form" | "instagram_dm",
): Promise<RunResult> {
  if (ops.kind !== "grok_playlist_control" && ops.kind !== "fendi") {
    return {
      status: 403,
      data: { error: `${ops.label} cannot mark manual submissions — Grok Playlist Control or Fendi only` },
    };
  }
  if (!can(ops, "send_playlist_pitches") && ops.kind !== "fendi") {
    return { status: 403, data: { error: `${ops.label} lacks send authority for manual submission` } };
  }

  const clean = stripSpoofedAttribution(body);
  const recordId = String(clean.handoff_record_id ?? clean.outreach_draft_id ?? "").trim();
  if (!recordId) {
    return {
      status: 400,
      data: {
        error: "handoff_record_id (or outreach_draft_id) required — playlist_id alone is not sufficient",
        code: "missing_handoff_record_id",
      },
    };
  }

  let record: Record<string, unknown> | null = null;
  if (clean.handoff_record_id) {
    const { data, error } = await sb
      .from("agh_handoff_records")
      .select("*")
      .eq("id", recordId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    record = data as Record<string, unknown> | null;
  } else {
    const { data, error } = await sb
      .from("agh_handoff_records")
      .select("*")
      .eq("outreach_draft_id", recordId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    record = data as Record<string, unknown> | null;
  }
  if (!record) return { status: 404, data: { error: "handoff record not found" } };

  // Idempotency: never overwrite original submission timestamp or submitting actor.
  if (record.submitted_at != null && String(record.submitted_at).trim() !== "") {
    return {
      status: 200,
      data: {
        ok: true,
        noop: true,
        idempotent: true,
        record,
        automated_submit: false,
        bulk_dm: false,
        unattended_send: false,
      },
    };
  }

  if (String(record.queue_state) !== "APPROVED_FOR_SEND") {
    return {
      status: 422,
      data: {
        error: `manual submit requires queue_state=APPROVED_FOR_SEND (got ${record.queue_state})`,
        code: "not_approved_for_send",
      },
    };
  }

  const trackId = String(record.track_id ?? "").trim();
  const playlistId = String(record.playlist_target_id ?? "").trim();
  if (!trackId) {
    return { status: 422, data: { error: "missing track identity on handoff record", code: "missing_track_id" } };
  }
  if (!playlistId) {
    return { status: 422, data: { error: "missing playlist_target_id on handoff record", code: "missing_playlist_id" } };
  }

  const envelope = await enforceTrackDnaLaneEnvelope(sb, {
    route: `mark_manual_${channel}`,
    trackId,
    playlistId,
    callerSongDnaVersionId: record.song_dna_version_id != null ? String(record.song_dna_version_id) : null,
    actor: ops,
  });
  if (!envelope.ok) {
    return {
      status: 422,
      data: {
        error: envelope.errors[0] ?? "dna_lane_rejected",
        code: envelope.errors[0] ?? "stale_or_incompatible",
        errors: envelope.errors,
      },
    };
  }

  const attr = attributionFrom(ops);
  const result = String(clean.result ?? clean.response_status ?? "submitted").trim();
  const { data: updated, error: updErr } = await sb
    .from("agh_handoff_records")
    .update({
      submitted_at: new Date().toISOString(),
      submitted_by: attr.actor_kind,
      submitted_by_label: attr.actor_label,
      manual_submit_channel: channel,
      manual_submit_result: result,
      song_dna_version_id: envelope.songDnaVersionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .eq("queue_state", "APPROVED_FOR_SEND")
    .select()
    .maybeSingle();
  if (updErr) return { status: 500, data: { error: updErr.message } };
  if (!updated) {
    return { status: 409, data: { error: "record state changed before submit stamp", code: "conflict" } };
  }

  // Mirror optional playlist_targets manual markers (non-authoritative path metadata).
  if (channel === "web_form") {
    const { error: ptErr } = await sb
      .from("playlist_targets")
      .update({
        form_manual_submitted_at: updated.submitted_at,
        form_manual_submit_result: result,
        form_manual_submitted_by: attr.actor_label,
        updated_at: new Date().toISOString(),
      })
      .eq("playlist_id", playlistId);
    if (ptErr) {
      return {
        status: 500,
        data: { error: `handoff stamped but playlist_targets mirror failed: ${ptErr.message}`, record: updated },
      };
    }
  } else {
    const { error: ptErr } = await sb
      .from("playlist_targets")
      .update({
        ig_manual_submitted_at: updated.submitted_at,
        ig_manual_response_status: result,
        ig_manual_submitted_by: attr.actor_label,
        updated_at: new Date().toISOString(),
      })
      .eq("playlist_id", playlistId);
    if (ptErr) {
      return {
        status: 500,
        data: { error: `handoff stamped but playlist_targets mirror failed: ${ptErr.message}`, record: updated },
      };
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      record: updated,
      automated_submit: false,
      bulk_dm: false,
      unattended_send: false,
    },
  };
}

/**
 * Advance every Claude-owned batch that is still waiting behind the tranche station
 * into AWAITING_GROK_REVIEW, independently of any station run.
 *
 * This is the stranded-batch repair: station completion used to advance one output
 * batch, so extra track-specific batches stayed at CLAUDE_BATCH_READY and needed a
 * manual CoS clearance before Grok could review them. Packet contents are never
 * recreated or modified here — only the queue state moves forward, one atomic
 * compare-and-set per batch, with authority enforced exactly as elsewhere.
 */
export async function advanceClaudeReadyBatches(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const clean = stripSpoofedAttribution(body);
  const authErr = authorizeHandoffState(ops, "AWAITING_GROK_REVIEW");
  if (authErr) return { status: 403, data: { error: authErr, code: "authority_denied" } };

  const explicitIds = Array.isArray(clean.batch_ids)
    ? clean.batch_ids.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const trackId = String(clean.track_id ?? "").trim();
  const batchKind = String(clean.batch_kind ?? "playlist").trim();
  const businessDate = clean.business_date_ct != null || clean.business_date != null
    ? String(clean.business_date_ct ?? clean.business_date).trim()
    : null;
  const pending: HandoffQueueState[] = ["CLAUDE_BATCH_READY", "CLAUDE_PLAYLIST_COMPLETE"];

  let candidateIds: string[] = explicitIds;
  if (candidateIds.length === 0) {
    let q = sb
      .from("agh_handoff_batches")
      .select("id, queue_state, batch_kind, business_date_ct, discovered_by")
      .in("queue_state", pending)
      .order("created_at", { ascending: true })
      .limit(200);
    if (batchKind) q = q.eq("batch_kind", batchKind);
    if (businessDate) q = q.eq("business_date_ct", businessDate);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    candidateIds = (data ?? []).map((b) => String(b.id));
  }

  // Optional track scope — batches carry no track_id, so resolve through their records.
  if (trackId && candidateIds.length > 0) {
    const { data: recs, error: rErr } = await sb
      .from("agh_handoff_records")
      .select("batch_id")
      .eq("track_id", trackId)
      .in("batch_id", candidateIds);
    if (rErr) return { status: 500, data: { error: rErr.message } };
    const allowed = new Set((recs ?? []).map((r) => String(r.batch_id)));
    candidateIds = candidateIds.filter((id) => allowed.has(id));
  }

  const advanced: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];

  for (const batchId of candidateIds) {
    const { data: batch, error: bErr } = await sb
      .from("agh_handoff_batches")
      .select("id, queue_state")
      .eq("id", batchId)
      .maybeSingle();
    if (bErr) return { status: 500, data: { error: bErr.message } };
    if (!batch) {
      failed.push({ batch_id: batchId, code: "batch_not_found" });
      continue;
    }
    let state = String(batch.queue_state);
    if (!pending.includes(state as HandoffQueueState)) {
      skipped.push({ batch_id: batchId, queue_state: state, reason: "not_claude_pending" });
      continue;
    }
    let stepFailed: RunResult | null = null;
    for (const next of ["CLAUDE_PLAYLIST_COMPLETE", "AWAITING_GROK_REVIEW"] as const) {
      if (state === next) continue;
      if (!canTransitionHandoff(state as HandoffQueueState, next)) continue;
      const step = await advanceHandoffBatch(sb, { batch_id: batchId, queue_state: next }, ops);
      if (step.status >= 400) {
        stepFailed = step;
        break;
      }
      state = next;
    }
    if (stepFailed) {
      failed.push({ batch_id: batchId, status: stepFailed.status, ...stepFailed.data });
      continue;
    }
    advanced.push({ batch_id: batchId, queue_state: state });
  }

  return {
    status: failed.length > 0 && advanced.length === 0 ? 422 : 200,
    data: {
      ok: failed.length === 0,
      advanced,
      advanced_count: advanced.length,
      skipped,
      failed,
      scope: {
        batch_ids: explicitIds.length > 0 ? explicitIds : null,
        track_id: trackId || null,
        batch_kind: batchKind || null,
        business_date_ct: businessDate,
      },
    },
  };
}

export async function runHandoffAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case "create_handoff_batch":
      return createHandoffBatch(sb, body, ops);
    case "add_handoff_records":
      return addHandoffRecords(sb, body, ops);
    case "advance_handoff_batch":
      return advanceHandoffBatch(sb, body, ops);
    case "review_handoff_batch":
      return reviewHandoffBatch(sb, body, ops);
    case "list_handoff_batches": {
      const limit = Math.min(Number(body.limit) || 40, 100);
      let q = sb
        .from("agh_handoff_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (typeof body.queue_state === "string") q = q.eq("queue_state", body.queue_state);
      if (typeof body.batch_kind === "string") q = q.eq("batch_kind", body.batch_kind);
      if (!unscopedHandoffReader(ops)) {
        q = q.eq("discovered_by", ops.kind);
      }
      const { data, error } = await q;
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [], scoped: !unscopedHandoffReader(ops) } };
    }
    case "get_handoff_batch": {
      const id = String(body.batch_id ?? body.id ?? "").trim();
      if (!id) return { status: 400, data: { error: "batch_id required" } };
      const { data: batch, error } = await sb
        .from("agh_handoff_batches")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (!batch) return { status: 404, data: { error: "batch not found" } };
      if (
        !unscopedHandoffReader(ops) &&
        batch.discovered_by &&
        batch.discovered_by !== ops.kind
      ) {
        return { status: 403, data: { error: "Cannot read another actor's handoff batch" } };
      }
      const { data: records } = await sb
        .from("agh_handoff_records")
        .select("*")
        .eq("batch_id", id)
        .order("created_at", { ascending: true });
      return { status: 200, data: { ok: true, batch, records: records ?? [] } };
    }
    case "mark_manual_form_submitted":
      return markManualFormSubmitted(sb, body, ops);
    case "mark_manual_ig_dm_submitted":
      return markManualIgDmSubmitted(sb, body, ops);
    default:
      return { status: 400, data: { error: `Unknown handoff action: ${action}` } };
  }
}

export { stampDiscover, stampDraft, stampReview };
