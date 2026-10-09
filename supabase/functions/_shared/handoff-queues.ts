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
import { curatorContactContext } from "./curator-contact.ts";
import {
  checkTargetSubmissionReady,
  holdFailingRecordsInBatch,
  recordRouteHold,
  routeActionability,
} from "./submission-route.ts";
import { decideLaneFit, fitRejectionConflict, isFitRejectionReason, type ApprovedDnaLanes } from "./song-fit.ts";
import { listWebFormHandoffs, plainManualSubmitError } from "./web-form-handoff.ts";

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
  "SENT",
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
  "materialize_email_handoff_drafts",
  "playlist_pipeline_report",
  "review_handoff_records",
  "approve_handoff_records",
  "reject_handoff_records",
  "list_web_form_handoffs",
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
  "SENT",
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
  // Written by a successful email send or a manual IG / web-form receipt.
  // Not an advance target: approval still has to happen before the send,
  // and this state is not a way to skip it.
  SENT: [],
};

const KNOWN_CHANNELS = new Set(["email", "web_form", "instagram_dm"]);

/** Metadata-only email packet fields. Never pitch copy (body/subject). */
export function mergeEmailHandoffPacketMeta(
  packet: Record<string, unknown>,
  opts: { curatorEmail: string; outreachDraftId: string; emailSendable?: boolean },
): Record<string, unknown> {
  const email = String(opts.curatorEmail ?? "").trim().toLowerCase();
  const out: Record<string, unknown> = { ...packet };
  out.packet_kind = out.packet_kind ?? "email_outreach_draft";
  out.channel = "email";
  out.curator_email = email;
  out.outreach_draft_id = opts.outreachDraftId;
  out.email_sendable = opts.emailSendable ?? true;
  return out;
}

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
    ops.kind === "claude_sync_discovery" ||
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
  const draft = stampDraft(ops);
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

      if (channel === "email") {
        const draftId = r.outreach_draft_id != null ? String(r.outreach_draft_id).trim() : "";
        if (!draftId) {
          return {
            status: 422,
            data: {
              error: "email handoff requires outreach_draft_id",
              code: "missing_outreach_draft_id",
              playlist_id: playlistId,
            },
          };
        }
        let curatorEmail = String(packet.curator_email ?? "").trim();
        if (!curatorEmail) {
          const { data: tgt, error: tgtErr } = await sb
            .from("playlist_targets")
            .select("curator_email")
            .eq("playlist_id", playlistId)
            .maybeSingle();
          if (tgtErr) return { status: 500, data: { error: tgtErr.message } };
          curatorEmail = String(tgt?.curator_email ?? "").trim();
        }
        if (!curatorEmail) {
          return {
            status: 422,
            data: {
              error: "email handoff requires curator_email",
              code: "missing_curator_email",
              playlist_id: playlistId,
            },
          };
        }
        Object.assign(
          packet,
          mergeEmailHandoffPacketMeta(packet, {
            curatorEmail,
            outreachDraftId: draftId,
            emailSendable: true,
          }),
        );
      }

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
        ...draft,
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
      ...draft,
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
  if (inserted > 0) {
    // Inventory records are drafts — persist drafted_by on the batch if still null.
    // Never overwrite an existing draft stamp.
    await sb
      .from("agh_handoff_batches")
      .update({
        drafted_by: draft.drafted_by,
        drafted_by_label: draft.drafted_by_label,
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .is("drafted_by", null);
  }
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
    ops.kind === "claude_sync_discovery" ||
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

  // Route boundary: records whose submission route fails the shared rules never move
  // forward with the batch — they go to a Claude-side repair batch (audit trail kept),
  // and the rest of the batch continues. Fails closed if the check is unavailable.
  let routeHeld: Record<string, unknown>[] = [];
  if (next === "GROK_REVIEWED" || next === "APPROVED_FOR_SEND") {
    const batchId = String(clean.batch_id ?? "").trim();
    if (batchId) {
      const hold = await holdFailingRecordsInBatch(sb, batchId, ops.label);
      if (!hold.ok) {
        return {
          status: hold.code === "migration_required" ? 503 : 500,
          data: {
            error: `route check blocked ${next}: ${hold.error}`,
            code: hold.code ?? "route_check_failed",
            failing_records: hold.held,
          },
        };
      }
      routeHeld = hold.held;
    }
  }
  if (next === "REJECTED_BY_GROK") {
    const batchId = String(clean.batch_id ?? "").trim();
    const { data: recs, error: rErr } = await sb
      .from("agh_handoff_records")
      .select("id, track_id, playlist_target_id, queue_state")
      .eq("batch_id", batchId);
    if (rErr) return { status: 500, data: { error: rErr.message, code: "db_error" } };
    // One fit authority: a batch reject citing DNA/lane mismatch cannot cover records
    // whose lane the song's approved DNA allows. Reject those per record for other reasons.
    if (isFitRejectionReason(clean.rejection_reason, clean.reason_code)) {
      const fit = await fitForRecords(sb, (recs ?? []) as Record<string, unknown>[]);
      const fitting = [...fit.entries()].filter(([, f]) => f.fit);
      if (fitting.length) {
        return {
          status: 409,
          data: {
            error: "rejection cites a DNA/lane mismatch, but some records' lanes are approved by the song's current Song DNA",
            code: "fit_decision_conflict",
            fitting_records: fitting.map(([id, f]) => ({ record_id: id, lane: f.lane, song_dna_version_id: f.song_dna_version_id, reason: f.reason })),
            policy_version: fitting[0][1].policy_version,
            hint: "Use review_handoff_records to reject specific records with a non-fit reason_code, or ask Fendi to change the approved Song DNA.",
          },
        };
      }
    }
    // A reject straight from AWAITING_GROK_REVIEW used to be an illegal transition (the
    // chain requires GROK_REVIEWED first), so Grok's rejections never persisted. Do both
    // steps: review, then reject.
    const { data: cur } = await sb.from("agh_handoff_batches").select("queue_state").eq("id", batchId).maybeSingle();
    if (cur?.queue_state === "AWAITING_GROK_REVIEW") {
      const step = await advanceHandoffBatch(sb, { ...clean, queue_state: "GROK_REVIEWED" }, ops);
      if (step.status >= 400) return step;
    }
  }
  const res = await advanceHandoffBatch(sb, { ...clean, queue_state: next }, ops);
  if (routeHeld.length) {
    res.data = { ...res.data, route_held: routeHeld, route_held_count: routeHeld.length };
  }
  return res;
}

/** Statuses a manual IG receipt must not overwrite. Anything else may become pitched. */
const LATER_OR_TERMINAL_PITCH_STATUS = new Set([
  "replied",
  "placed",
  "declined",
  "pay_to_play",
  "paid",
  "inactive",
]);

function blankValue(v: unknown): boolean {
  return v == null || String(v).trim() === "";
}

function packetObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function receiptInstant(value: unknown): string | null {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function isLaterOrTerminalPitchStatus(status: unknown): boolean {
  return LATER_OR_TERMINAL_PITCH_STATUS.has(String(status ?? "").trim().toLowerCase());
}

/** Fendi-authored drafts stay on attribution hold. drafted_by lives on the row when present, else in metadata. */
export function isAttributionHeldDraft(row: Record<string, unknown>): boolean {
  const meta = packetObject(row.metadata);
  return [row.generated_by, row.drafted_by, meta.generated_by, meta.drafted_by]
    .some((v) => String(v ?? "").trim().toLowerCase() === "fendi");
}

function draftHandoffId(row: Record<string, unknown>): string {
  return String(packetObject(row.metadata).handoff_record_id ?? "").trim();
}

/**
 * One approved instagram_dm draft for this track + playlist.
 * A handoff match that is attribution-held is not replaced by a different draft.
 * Otherwise prefer metadata.handoff_record_id, then the oldest remaining draft.
 */
export function chooseManualIgDraft(
  rows: Record<string, unknown>[],
  handoffId: string,
): { draft: Record<string, unknown> | null; skipped: "attribution_held" | null } {
  const heldMatch = rows.some((row) => isAttributionHeldDraft(row) && draftHandoffId(row) === handoffId);
  if (heldMatch) return { draft: null, skipped: "attribution_held" };
  const open = rows.filter((row) => !isAttributionHeldDraft(row));
  if (!open.length) return { draft: null, skipped: rows.length ? "attribution_held" : null };
  const preferred = open.find((row) => draftHandoffId(row) === handoffId);
  if (preferred) return { draft: preferred, skipped: null };
  const sorted = [...open].sort((a, b) => {
    const created = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    if (created !== 0) return created;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
  return { draft: sorted[0] ?? null, skipped: null };
}

/**
 * Columns to write on playlist_targets for one IG receipt.
 * First stamp uses the receipt time. A replay fills gaps only and does not move a time already stored.
 * Returns null when the row is already consistent.
 */
export function igReceiptTargetPatch(opts: {
  pitchStatus: unknown;
  lastPitchedAt: unknown;
  igManualSubmittedAt: unknown;
  submittedAt: string;
  result: string;
  actorLabel: string;
  replay: boolean;
}): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const status = String(opts.pitchStatus ?? "").trim().toLowerCase();
  if (!isLaterOrTerminalPitchStatus(status)) {
    if (!opts.replay || status !== "pitched") patch.pitch_status = "pitched";
    if (!opts.replay || blankValue(opts.lastPitchedAt)) patch.last_pitched_at = opts.submittedAt;
  }
  if (!opts.replay || blankValue(opts.igManualSubmittedAt)) {
    patch.ig_manual_submitted_at = opts.submittedAt;
    patch.ig_manual_response_status = opts.result;
    patch.ig_manual_submitted_by = opts.actorLabel;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * A manual receipt moves APPROVED_FOR_SEND to SENT.
 * SENT itself, and anything already past it (import) or otherwise terminal
 * (reject), stays put so a replay cannot downgrade the row.
 */
export function manualReceiptSentTransition(queueState: unknown): "SENT" | null {
  return String(queueState ?? "").trim() === "APPROVED_FOR_SEND" ? "SENT" : null;
}

/**
 * Second write after the submitted_at stamp. The manual-submission trigger
 * inserts pitch_log only while queue_state is still APPROVED_FOR_SEND and
 * submitted_at was previously null. Setting SENT in that same update raises
 * pass_approval_required and rolls the receipt back. This update does not
 * touch submitted_at or submitted_by.
 */
async function closeManualReceiptQueue(
  sb: SupabaseClient,
  record: Record<string, unknown>,
): Promise<{ ok: true; promoted: boolean } | { ok: false; error: string }> {
  if (manualReceiptSentTransition(record.queue_state) !== "SENT") {
    return { ok: true, promoted: false };
  }
  const { data, error } = await sb
    .from("agh_handoff_records")
    .update({
      queue_state: "SENT",
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .eq("queue_state", "APPROVED_FOR_SEND")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (data) record.queue_state = "SENT";
  return { ok: true, promoted: data != null };
}

function manualReceiptQueueFailure(record: Record<string, unknown>, error: string): RunResult {
  return {
    status: 500,
    data: {
      error: `receipt logged but queue_state was not moved to SENT: ${error}`,
      code: "queue_state_followthrough_failed",
      record,
    },
  };
}

function receiptPitchLogId(record: Record<string, unknown>): string {
  const receipt = packetObject(packetObject(record.packet).submission_receipt);
  return String(receipt.pitch_log_id ?? "").trim();
}

async function resolveManualPitchLogId(
  sb: SupabaseClient,
  record: Record<string, unknown>,
): Promise<{ id: string | null; error?: string }> {
  const fromPacket = receiptPitchLogId(record);
  if (fromPacket) return { id: fromPacket };
  const { data, error } = await sb
    .from("agh_manual_submission_receipts")
    .select("pitch_log_id")
    .eq("handoff_record_id", record.id)
    .maybeSingle();
  if (error) return { id: null, error: error.message };
  const id = String((data as { pitch_log_id?: unknown } | null)?.pitch_log_id ?? "").trim();
  return { id: id || null };
}

/**
 * After the handoff stamp (the DB trigger writes pitch_log), bring the playlist
 * target and the matching approved Instagram draft in line with that same receipt.
 * Replay is safe: it does not insert another pitch_log and does not move timestamps
 * that are already stored.
 */
async function finishManualIgDmReceipt(
  sb: SupabaseClient,
  opts: {
    record: Record<string, unknown>;
    submittedAt: string;
    result: string;
    actorLabel: string;
    replay: boolean;
  },
): Promise<{ status: number; data: Record<string, unknown>; extra: Record<string, unknown> }> {
  const playlistId = String(opts.record.playlist_target_id ?? "").trim();
  const trackId = String(opts.record.track_id ?? "").trim();
  const handoffId = String(opts.record.id ?? "").trim();
  const fail = (error: string, code = "receipt_followthrough_failed"): {
    status: number;
    data: Record<string, unknown>;
    extra: Record<string, unknown>;
  } => ({
    status: 500,
    data: { error, code, record: opts.record },
    extra: {},
  });

  const { data: target, error: targetErr } = await sb
    .from("playlist_targets")
    .select("playlist_id, pitch_status, last_pitched_at, ig_manual_submitted_at")
    .eq("playlist_id", playlistId)
    .maybeSingle();
  if (targetErr) return fail(`handoff stamped but playlist_targets read failed: ${targetErr.message}`);
  if (!target) return fail("handoff stamped but playlist target is missing");

  const targetRow = target as Record<string, unknown>;
  const targetPatch = igReceiptTargetPatch({
    pitchStatus: targetRow.pitch_status,
    lastPitchedAt: targetRow.last_pitched_at,
    igManualSubmittedAt: targetRow.ig_manual_submitted_at,
    submittedAt: opts.submittedAt,
    result: opts.result,
    actorLabel: opts.actorLabel,
    replay: opts.replay,
  });
  let targetWrote = false;
  if (targetPatch) {
    const { error: ptErr } = await sb
      .from("playlist_targets")
      .update({ ...targetPatch, updated_at: new Date().toISOString() })
      .eq("playlist_id", playlistId);
    if (ptErr) return fail(`handoff stamped but playlist_targets mirror failed: ${ptErr.message}`);
    targetWrote = true;
  }

  // select * so a drafted_by column is visible where the table has one, without failing where it does not.
  const { data: draftRows, error: draftErr } = await sb
    .from("outreach_drafts")
    .select("*")
    .eq("track_id", trackId)
    .eq("playlist_id", playlistId)
    .eq("channel", "instagram_dm")
    .eq("status", "approved");
  if (draftErr) return fail(`handoff stamped but outreach_drafts read failed: ${draftErr.message}`);
  const drafts = (draftRows ?? []) as Record<string, unknown>[];

  const choice = chooseManualIgDraft(drafts, handoffId);
  let pitchLogId = receiptPitchLogId(opts.record) || null;
  let draftId: string | null = null;
  if (choice.draft) {
    const needsSentAt = blankValue(choice.draft.sent_at);
    const needsLog = blankValue(choice.draft.pitch_log_id);
    if (needsLog && !pitchLogId) {
      const resolved = await resolveManualPitchLogId(sb, opts.record);
      if (resolved.error) return fail(`handoff stamped but pitch_log lookup failed: ${resolved.error}`);
      pitchLogId = resolved.id;
    }
    if (needsLog && !pitchLogId) {
      return fail(
        "handoff stamped but the manual submission receipt has no pitch_log id",
        "missing_pitch_log",
      );
    }
    const patch: Record<string, unknown> = {
      status: "sent",
      updated_at: new Date().toISOString(),
    };
    if (needsSentAt) patch.sent_at = opts.submittedAt;
    if (needsLog && pitchLogId) patch.pitch_log_id = pitchLogId;
    const { data: sent, error: sentErr } = await sb
      .from("outreach_drafts")
      .update(patch)
      .eq("id", choice.draft.id)
      .eq("status", "approved")
      .select("id")
      .maybeSingle();
    if (sentErr) return fail(`handoff stamped but outreach_drafts update failed: ${sentErr.message}`);
    if (sent) draftId = String((sent as { id?: unknown }).id ?? choice.draft.id);
  }

  const preserved = isLaterOrTerminalPitchStatus(targetRow.pitch_status);
  return {
    status: 200,
    data: { ok: true },
    extra: {
      pitch_log_id: pitchLogId,
      target_pitch_status: preserved ? String(targetRow.pitch_status ?? "") : "pitched",
      target_status_preserved: preserved,
      last_pitched_at: preserved
        ? (targetRow.last_pitched_at ?? null)
        : (targetPatch?.last_pitched_at ?? targetRow.last_pitched_at ?? opts.submittedAt),
      outreach_draft_id: draftId,
      outreach_draft_skipped: choice.skipped,
      repaired: targetWrote || draftId != null,
    },
  };
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
  // The pitch_log row was written by the manual-submission trigger on the first stamp.
  // A replay fills a target, draft, or queue_state the first stamp left behind, using
  // that original receipt time. It does not insert another pitch_log.
  if (record.submitted_at != null && String(record.submitted_at).trim() !== "") {
    let follow: { status: number; data: Record<string, unknown>; extra: Record<string, unknown> } | null = null;
    if (channel === "instagram_dm") {
      const submittedAt = receiptInstant(record.submitted_at);
      if (!submittedAt) {
        return { status: 500, data: { error: "stored submitted_at is not a timestamp", record } };
      }
      follow = await finishManualIgDmReceipt(sb, {
        record,
        submittedAt,
        result: String(record.manual_submit_result ?? "submitted"),
        actorLabel: String(record.submitted_by_label ?? ""),
        replay: true,
      });
      if (follow.status >= 400) return { status: follow.status, data: follow.data };
    }
    const closed = await closeManualReceiptQueue(sb, record);
    if (!closed.ok) return manualReceiptQueueFailure(record, closed.error);
    const extra = follow?.extra ?? {};
    const repaired = extra.repaired === true || closed.promoted;
    return {
      status: 200,
      data: {
        ok: true,
        noop: !repaired,
        idempotent: true,
        record,
        automated_submit: false,
        bulk_dm: false,
        unattended_send: false,
        ...extra,
        repaired,
        queue_state: record.queue_state,
        queue_state_updated: closed.promoted,
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

  // Route boundary: old packets verified under the defective rules cannot be submitted.
  const hold = recordRouteHold(record);
  if (hold) {
    return {
      status: 422,
      data: {
        error: `record is on route hold: ${String(hold.reason ?? hold.code ?? "route_hold")}`,
        code: "route_hold",
        route_hold: hold,
      },
    };
  }
  const recordChannel = String(record.submission_channel ?? "").trim();
  if (recordChannel && recordChannel !== channel) {
    return {
      status: 422,
      data: {
        error: `record channel is ${recordChannel}, not ${channel}`,
        code: "channel_mismatch",
      },
    };
  }
  const readiness = await checkTargetSubmissionReady(sb, playlistId, channel);
  if (!readiness.ok) {
    return {
      status: readiness.query_error ? 500 : 422,
      data: {
        error: `submission route not ready: ${readiness.reason}`,
        code: "route_not_submission_ready",
        route_code: readiness.code,
        submission_terms: readiness.submission_terms,
      },
    };
  }

  // Existing per-song contact rule, applied at curator identity (sibling playlists that
  // share the same form / IG account / email).
  const { data: targetRow, error: targetErr } = await sb
    .from("playlist_targets")
    .select("playlist_id, curator_email, form_url, ig_curator_account, curator_instagram")
    .eq("playlist_id", playlistId)
    .maybeSingle();
  if (targetErr) return { status: 500, data: { error: targetErr.message, code: "curator_check_failed" } };
  const contact = await curatorContactContext(sb, {
    target: (targetRow ?? { playlist_id: playlistId }) as Record<string, unknown>,
    trackId,
    trackName: null,
  });
  if (contact.error) {
    return { status: 500, data: { error: `curator contact check failed: ${contact.error}`, code: "curator_check_failed" } };
  }
  if (contact.same_song_block) {
    return {
      status: 422,
      data: {
        error: "this curator already received this song within the existing cooldown (via a sibling playlist)",
        code: "curator_cooldown_same_song",
        prior_contact: contact.same_song_block,
        cooldown_days: contact.cooldown_days,
      },
    };
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

  const evidence = clean.evidence as Record<string, unknown> | undefined;
  const submittedTime = Date.parse(String(evidence?.submitted_at ?? ""));
  if (!evidence || evidence.result !== "submitted" || !String(evidence.reference ?? "").trim() ||
      !String(evidence.notes ?? "").trim() || !Number.isFinite(submittedTime) || submittedTime > Date.now() + 60000) {
    return { status: 422, data: { code: "submission_evidence_required",
      error: "evidence requires result=submitted, reference, notes, and a valid non-future submitted_at" } };
  }
  const attr = attributionFrom(ops);
  const result = String(clean.result ?? clean.response_status ?? "submitted").trim();
  const { data: updated, error: updErr } = await sb
    .from("agh_handoff_records")
    .update({
      submitted_at: new Date(submittedTime).toISOString(),
      packet: { ...(record.packet as Record<string, unknown> ?? {}), submission_evidence: evidence },
      submitted_by: attr.actor_kind,
      submitted_by_label: attr.actor_label,
      manual_submit_channel: channel,
      manual_submit_result: result,
      song_dna_version_id: envelope.songDnaVersionId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .eq("queue_state", "APPROVED_FOR_SEND")
    .is("submitted_at", null)
    .select()
    .maybeSingle();
  if (updErr) {
    const plain = plainManualSubmitError(updErr.message);
    if (plain) return { status: 422, data: plain };
    return { status: 500, data: { error: updErr.message } };
  }
  if (!updated) {
    return { status: 409, data: { error: "record state changed before submit stamp", code: "conflict" } };
  }

  // Web forms mirror manual markers only. An Instagram receipt also moves the
  // target to pitched and closes the matching approved draft, using this same time.
  // queue_state stays APPROVED_FOR_SEND until those writes finish: the pitch_log
  // trigger rejects a first stamp whose new queue_state is already SENT.
  const stamped = updated as Record<string, unknown>;
  let followExtra: Record<string, unknown> = {};
  if (channel === "web_form") {
    const { error: ptErr } = await sb
      .from("playlist_targets")
      .update({
        form_manual_submitted_at: stamped.submitted_at,
        form_manual_submit_result: result,
        form_manual_submitted_by: attr.actor_label,
        updated_at: new Date().toISOString(),
      })
      .eq("playlist_id", playlistId);
    if (ptErr) {
      return {
        status: 500,
        data: { error: `handoff stamped but playlist_targets mirror failed: ${ptErr.message}`, record: stamped },
      };
    }
  } else {
    const submittedAt = receiptInstant(stamped.submitted_at);
    if (!submittedAt) {
      return { status: 500, data: { error: "stored submitted_at is not a timestamp", record: stamped } };
    }
    const follow = await finishManualIgDmReceipt(sb, {
      record: stamped,
      submittedAt,
      result,
      actorLabel: attr.actor_label,
      replay: false,
    });
    if (follow.status >= 400) return { status: follow.status, data: follow.data };
    followExtra = follow.extra;
  }

  const closed = await closeManualReceiptQueue(sb, stamped);
  if (!closed.ok) return manualReceiptQueueFailure(stamped, closed.error);

  return {
    status: 200,
    data: {
      ok: true,
      record: stamped,
      automated_submit: false,
      bulk_dm: false,
      unattended_send: false,
      ...followExtra,
      queue_state: stamped.queue_state,
      queue_state_updated: closed.promoted,
    },
  };
}

/**
 * Opt-in preview. Only boolean true and the string "true" are dry runs.
 * Absent, false, and every other value keep the live advance.
 */
function isDryRun(value: unknown): boolean {
  return value === true || value === "true";
}

/** Records advance_agh_handoff_batch would rewrite. Individually rejected rows stay put. */
function movableRecordCount(records: Record<string, unknown>[]): number {
  return records.filter((r) => String(r.queue_state ?? "") !== "REJECTED_BY_GROK").length;
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
 *
 * dry_run true (boolean or the string "true") returns the batches that would move
 * — ids, record counts, from/to status, and why any batch would be skipped —
 * and does not write status, audit rows, or anything else.
 */
export async function advanceClaudeReadyBatches(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const clean = stripSpoofedAttribution(body);
  const dryRun = isDryRun(clean.dry_run);
  const authErr = authorizeHandoffState(ops, "AWAITING_GROK_REVIEW");
  if (authErr) return { status: 403, data: { error: authErr, code: "authority_denied", dry_run: dryRun } };

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
    if (error) return { status: 500, data: { error: error.message, dry_run: dryRun } };
    candidateIds = (data ?? []).map((b) => String(b.id));
  }

  // Optional track scope — batches carry no track_id, so resolve through their records.
  if (trackId && candidateIds.length > 0) {
    const { data: recs, error: rErr } = await sb
      .from("agh_handoff_records")
      .select("batch_id")
      .eq("track_id", trackId)
      .in("batch_id", candidateIds);
    if (rErr) return { status: 500, data: { error: rErr.message, dry_run: dryRun } };
    const allowed = new Set((recs ?? []).map((r) => String(r.batch_id)));
    candidateIds = candidateIds.filter((id) => allowed.has(id));
  }

  const advanced: Record<string, unknown>[] = [];
  const wouldMove: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const failed: Record<string, unknown>[] = [];

  for (const batchId of candidateIds) {
    const { data: batch, error: bErr } = await sb
      .from("agh_handoff_batches")
      .select("id, queue_state")
      .eq("id", batchId)
      .maybeSingle();
    if (bErr) return { status: 500, data: { error: bErr.message, dry_run: dryRun } };
    if (!batch) {
      failed.push({ batch_id: batchId, code: "batch_not_found" });
      continue;
    }
    let state = String(batch.queue_state);
    if (!pending.includes(state as HandoffQueueState)) {
      skipped.push({
        batch_id: batchId,
        queue_state: state,
        from_status: state,
        reason: "not_claude_pending",
      });
      continue;
    }
    // Repair batches go back to Grok only once every route hold is resolved.
    const { data: heldRecs, error: hErr } = await sb
      .from("agh_handoff_records")
      .select("id, queue_state, packet")
      .eq("batch_id", batchId);
    if (hErr) return { status: 500, data: { error: hErr.message, dry_run: dryRun } };
    const records = (heldRecs ?? []) as Record<string, unknown>[];
    const unresolved = records
      .filter((r) => recordRouteHold(r))
      .map((r) => ({ record_id: r.id, route_hold: recordRouteHold(r) }));
    if (unresolved.length) {
      skipped.push({
        batch_id: batchId,
        queue_state: state,
        from_status: state,
        reason: "route_hold_unresolved",
        held_records: unresolved,
      });
      continue;
    }
    // Preview stops here. The live path below is the only writer (status CAS +
    // the advance RPC, which is also what stamps audit-bearing row updates).
    if (dryRun) {
      wouldMove.push({
        batch_id: batchId,
        record_count: movableRecordCount(records),
        from_status: state,
        to_status: "AWAITING_GROK_REVIEW",
      });
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

  const plannedCount = dryRun ? wouldMove.length : advanced.length;
  return {
    status: failed.length > 0 && plannedCount === 0 ? 422 : 200,
    data: {
      ok: failed.length === 0,
      dry_run: dryRun,
      ...(dryRun
        ? { would_move: wouldMove, would_move_count: wouldMove.length, advanced: [], advanced_count: 0 }
        : { advanced, advanced_count: advanced.length }),
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

/**
 * Queue health for the Claude → Grok → send pipeline. Reviewed ≠ approved ≠ submitted:
 * each is counted separately. Includes a stranded-batch check (Claude-side batches that
 * were never advanced) so promotion regressions are visible.
 */
export async function playlistPipelineReport(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const now = new Date();
  const staleHours = Math.max(1, Number(body.stranded_after_hours) || 2);
  let bq = sb
    .from("agh_handoff_batches")
    .select("id, queue_state, track_id, record_count, created_at, updated_at, payload, discovered_by, business_date_ct")
    .eq("batch_kind", "playlist")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (!unscopedHandoffReader(ops)) bq = bq.eq("discovered_by", ops.kind);
  const { data: batches, error: bErr } = await bq;
  if (bErr) return { status: 500, data: { error: `batch_query_failed:${bErr.message}`, code: "db_error" } };
  const batchRows = (batches ?? []) as Record<string, unknown>[];
  const batchIds = batchRows.map((b) => String(b.id));

  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < batchIds.length; i += 200) {
    const { data, error } = await sb
      .from("agh_handoff_records")
      .select("id, batch_id, queue_state, track_id, submitted_at, created_at, packet, rejection_reason, submission_channel")
      .in("batch_id", batchIds.slice(i, i + 200));
    if (error) return { status: 500, data: { error: `records_query_failed:${error.message}`, code: "db_error" } };
    records.push(...((data ?? []) as Record<string, unknown>[]));
  }

  const ageHours = (iso: unknown) => {
    const t = Date.parse(String(iso ?? ""));
    return Number.isFinite(t) ? Math.round((now.getTime() - t) / 36e5 * 10) / 10 : null;
  };
  const isRepair = (b: Record<string, unknown>) =>
    String((b.payload as Record<string, unknown> | null)?.route_hold_repair ?? "") === "true";

  const byState: Record<string, { batches: number; records: number }> = {};
  for (const b of batchRows) {
    const st = String(b.queue_state);
    byState[st] ??= { batches: 0, records: 0 };
    byState[st].batches++;
  }
  for (const r of records) {
    const st = String(r.queue_state);
    byState[st] ??= { batches: 0, records: 0 };
    byState[st].records++;
  }

  const pendingReview = batchRows.filter((b) => b.queue_state === "AWAITING_GROK_REVIEW");
  const oldestPending = pendingReview[0] ?? null;
  const stranded = batchRows.filter((b) =>
    (b.queue_state === "CLAUDE_BATCH_READY" || b.queue_state === "CLAUDE_PLAYLIST_COMPLETE") &&
    !isRepair(b) && (ageHours(b.created_at) ?? 0) >= staleHours
  );
  const repair = batchRows.filter((b) => isRepair(b) && b.queue_state === "CLAUDE_BATCH_READY");

  const holdReasons: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};
  for (const r of records) {
    const hold = (r.packet as Record<string, unknown> | null)?.route_hold as Record<string, unknown> | undefined;
    if (hold && !r.submitted_at) {
      const code = String(hold.code ?? "route_hold");
      holdReasons[code] = (holdReasons[code] ?? 0) + 1;
    }
    if (r.queue_state === "REJECTED_BY_GROK") {
      const why = String(r.rejection_reason ?? "unspecified").slice(0, 80);
      rejectionReasons[why] = (rejectionReasons[why] ?? 0) + 1;
    }
  }
  const submitted = records.filter((r) => r.submitted_at);

  return {
    status: 200,
    data: {
      ok: true,
      scoped: !unscopedHandoffReader(ops),
      generated_at: now.toISOString(),
      by_state: byState,
      review_backlog: {
        batches: pendingReview.length,
        records: records.filter((r) => r.queue_state === "AWAITING_GROK_REVIEW").length,
        oldest_pending_batch_id: oldestPending?.id ?? null,
        oldest_pending_age_hours: oldestPending ? ageHours(oldestPending.created_at) : null,
      },
      reviewed_not_approved_records: records.filter((r) => r.queue_state === "GROK_REVIEWED").length,
      approved_not_submitted_records: records.filter((r) =>
        (r.queue_state === "APPROVED_FOR_SEND" || r.queue_state === "AWAITING_AGH_IMPORT") && !r.submitted_at
      ).length,
      manual_submissions_recorded: submitted.length,
      rejected_records: records.filter((r) => r.queue_state === "REJECTED_BY_GROK").length,
      rejection_reasons: rejectionReasons,
      route_holds: {
        records: Object.values(holdReasons).reduce((a, b) => a + b, 0),
        by_code: holdReasons,
        repair_batches: repair.map((b) => ({ id: b.id, record_count: b.record_count, created_at: b.created_at })),
      },
      stranded_claude_batches: {
        threshold_hours: staleHours,
        count: stranded.length,
        batch_ids: stranded.map((b) => b.id),
        note: "Claude-side batches older than the threshold that never reached AWAITING_GROK_REVIEW. Clear with advance_playlist_batches.",
      },
      note: "Reviewed, approved and submitted are separate counts. Email sends are counted in pitch_log (see per-song funnel in get_playlist_discovery_work).",
    },
  };
}

const MATERIALIZE_ACTORS = new Set([
  "grok_playlist_control",
  "fendi",
  "claude",
  "claude_playlist_discovery",
  "human_admin",
]);

export async function materializeEmailHandoffDrafts(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  if (!MATERIALIZE_ACTORS.has(ops.kind)) {
    return {
      status: 403,
      data: {
        error: `${ops.label} cannot materialize email handoff drafts`,
        code: "authority_denied",
      },
    };
  }
  if (!can(ops, "write_playlist_ops") && !can(ops, "generate_playlist_drafts")) {
    return {
      status: 403,
      data: { error: `${ops.label} lacks materialize capability`, code: "authority_denied" },
    };
  }

  const clean = stripSpoofedAttribution(body);
  const dryRun = clean.dry_run !== false;
  const batchId = String(clean.batch_id ?? "").trim() || null;
  const trackId = String(clean.track_id ?? "").trim() || null;

  const { data, error } = await sb.rpc("agh_materialize_email_handoff_drafts", {
    p_dry_run: dryRun,
    p_batch_id: batchId,
    p_track_id: trackId,
  });

  if (error) {
    const msg = String(error.message || "");
    const unavailable =
      /could not find the function/i.test(msg) ||
      /permission denied/i.test(msg) ||
      error.code === "PGRST202" ||
      error.code === "42883";
    return {
      status: unavailable ? 503 : 500,
      data: {
        error: unavailable
          ? "agh_materialize_email_handoff_drafts RPC unavailable — apply 20260916120000 via Lovable SQL Editor"
          : `materialize failed: ${msg}`,
        code: unavailable ? "rpc_unavailable" : "rpc_failed",
      },
    };
  }

  const result = (data && typeof data === "object") ? data as Record<string, unknown> : {};
  return {
    status: 200,
    data: {
      ok: true,
      dry_run: dryRun,
      sent: false,
      automated_submit: false,
      ...result,
    },
  };
}


// ---------------------------------------------------------------------------
// Record-level truth: batch summaries built from record states, Grok record review.
// ---------------------------------------------------------------------------

export type RecordCounts = Record<string, number>;

/** Per-batch counts of records by queue_state (record state is authoritative). */
export async function loadBatchRecordCounts(
  sb: SupabaseClient,
  batchIds: string[],
): Promise<{ counts: Map<string, RecordCounts>; error: string | null }> {
  const counts = new Map<string, RecordCounts>();
  for (const id of batchIds) counts.set(id, {});
  for (let i = 0; i < batchIds.length; i += 200) {
    const { data, error } = await sb
      .from("agh_handoff_records")
      .select("batch_id, queue_state")
      .in("batch_id", batchIds.slice(i, i + 200));
    if (error) return { counts, error: error.message };
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const c = counts.get(String(r.batch_id)) ?? {};
      const st = String(r.queue_state);
      c[st] = (c[st] ?? 0) + 1;
      counts.set(String(r.batch_id), c);
    }
  }
  return { counts, error: null };
}

const ACTIONABLE_RECORD_STATES = ["CLAUDE_BATCH_READY", "CLAUDE_PLAYLIST_COMPLETE", "AWAITING_GROK_REVIEW", "GROK_REVIEWED", "APPROVED_FOR_SEND"];

/**
 * Human/agent-readable batch summary from record counts. A batch whose records disagree
 * is reported as mixed with every non-zero state listed, so neither "pending" nor
 * "rejected" at batch level hides records that still need action.
 */
export function batchStatusSummary(batchState: string, counts: RecordCounts): Record<string, unknown> {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const states = Object.entries(counts).filter(([, n]) => n > 0);
  const mixed = states.length > 1 || (states.length === 1 && states[0][0] !== batchState);
  const actionable = ACTIONABLE_RECORD_STATES.reduce((a, st) => a + (counts[st] ?? 0), 0);
  const parts = states.sort((a, b) => b[1] - a[1]).map(([st, n]) => `${n} ${st}`);
  return {
    record_counts: counts,
    record_total: total,
    actionable_records: actionable,
    rejected_records: counts.REJECTED_BY_GROK ?? 0,
    mixed,
    summary: total === 0
      ? `${batchState} (no records)`
      : `${batchState} batch — records: ${parts.join(", ")}${mixed ? " (mixed — act per record)" : ""}`,
  };
}

/** Current approved Song DNA lanes for a track (null when missing / unapproved). */
async function loadApprovedDnaLanes(sb: SupabaseClient, trackId: string): Promise<ApprovedDnaLanes | null> {
  if (!trackId) return null;
  const { data: t } = await sb.from("tracks").select("approved_song_dna_version_id").eq("id", trackId).maybeSingle();
  const id = t?.approved_song_dna_version_id ? String(t.approved_song_dna_version_id) : "";
  if (!id) return null;
  const { data: d } = await sb
    .from("song_dna_versions")
    .select("id, track_id, approval_state, primary_genre, approved_lanes, excluded_lanes")
    .eq("id", id)
    .maybeSingle();
  if (!d || String(d.track_id) !== trackId || String(d.approval_state) !== "approved") return null;
  return d as ApprovedDnaLanes;
}

/** Fit decisions for a batch's records against each record's song's current approved DNA. */
async function fitForRecords(
  sb: SupabaseClient,
  records: Record<string, unknown>[],
): Promise<Map<string, ReturnType<typeof decideLaneFit>>> {
  const out = new Map<string, ReturnType<typeof decideLaneFit>>();
  const pids = [...new Set(records.map((r) => String(r.playlist_target_id ?? "")).filter(Boolean))];
  const lanes = new Map<string, unknown>();
  for (let i = 0; i < pids.length; i += 200) {
    const { data } = await sb.from("playlist_targets").select("playlist_id, lane").in("playlist_id", pids.slice(i, i + 200));
    for (const t of (data ?? []) as Record<string, unknown>[]) lanes.set(String(t.playlist_id), t.lane);
  }
  const dnaByTrack = new Map<string, ApprovedDnaLanes | null>();
  for (const r of records) {
    const tid = String(r.track_id ?? "");
    if (!dnaByTrack.has(tid)) dnaByTrack.set(tid, await loadApprovedDnaLanes(sb, tid));
    out.set(String(r.id), decideLaneFit(dnaByTrack.get(tid) ?? null, lanes.get(String(r.playlist_target_id ?? ""))));
  }
  return out;
}

function denyNonFinalAuthority(ops: OpsActor): RunResult | null {
  if (!can(ops, "review_handoff_batch") && !can(ops, "approve_playlist_drafts")) {
    return { status: 403, data: { error: `${ops.label} cannot review handoff records` } };
  }
  if (
    ops.kind === "claude" || ops.kind === "claude_playlist_discovery" || ops.kind === "claude_sync_discovery" ||
    ops.kind === "service" || ops.kind === "human_admin"
  ) {
    return { status: 403, data: { error: `${ops.label} cannot act as final handoff authority` } };
  }
  return null;
}

const RECORD_DECISIONS = new Set(["reviewed", "reject", "defer", "approve"]);

/**
 * Grok record-level review. Each record gets its own decision — reviewed, reject (with
 * one or more reason codes), or defer (retry later; stays in review). The batch state is
 * derived afterwards from its records and never moves backwards. A reject that cites a
 * DNA/lane mismatch contradicting the song's approved DNA is refused per record
 * (fit_decision_conflict); rejections for other reasons are Grok's call.
 */
export async function reviewHandoffRecords(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = denyNonFinalAuthority(ops);
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const batchId = String(clean.batch_id ?? "").trim();
  const decisions = Array.isArray(clean.decisions) ? clean.decisions as Record<string, unknown>[] : [];
  if (!batchId || !decisions.length || decisions.length > 200) {
    return { status: 400, data: { error: "batch_id and 1–200 decisions required", code: "bad_request" } };
  }
  const bad = decisions.find((d) => !d || typeof d !== "object" || !String(d.record_id ?? "").trim() ||
    !RECORD_DECISIONS.has(String(d.decision ?? "").toLowerCase()));
  if (bad) {
    return { status: 400, data: { error: "each decision needs record_id and decision reviewed|reject|defer|approve", code: "bad_request", bad } };
  }
  if (decisions.some((d) => String(d.decision).toLowerCase() === "reject") && !can(ops, "reject_playlist_drafts")) {
    return { status: 403, data: { error: `${ops.label} cannot reject handoff records` } };
  }

  const { data: recs, error: rErr } = await sb
    .from("agh_handoff_records")
    .select("id, batch_id, track_id, playlist_target_id, queue_state")
    .eq("batch_id", batchId);
  if (rErr) return { status: 500, data: { error: rErr.message, code: "db_error" } };
  const recRows = (recs ?? []) as Record<string, unknown>[];
  const fit = await fitForRecords(sb, recRows);

  const conflicts: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  for (const d of decisions) {
    const recordId = String(d.record_id).trim();
    const decision = String(d.decision).toLowerCase();
    const codes = [
      ...(Array.isArray(d.reason_codes) ? d.reason_codes.map(String) : []),
      ...(d.reason_code != null ? [String(d.reason_code)] : []),
    ].map((c) => c.trim()).filter(Boolean);
    const reason = d.reason != null ? String(d.reason).slice(0, 2000) : null;
    if (decision === "approve") {
      if (!can(ops, "approve_playlist_drafts") || d.verdict !== "PASS" || !reason || !fit.get(recordId)?.fit) {
        conflicts.push({ record_id: recordId, code: "pass_review_required" }); continue;
      }
      const record = recRows.find(r => String(r.id) === recordId);
      const ready = await checkTargetSubmissionReady(sb, String(record?.playlist_target_id ?? ""));
      if (!ready.ok) { conflicts.push({ record_id: recordId, code: ready.code, reason: ready.reason }); continue; }
    }
    if (decision === "reject") {
      if (!codes.length && !reason) {
        conflicts.push({ record_id: recordId, code: "reason_required", message: "reject needs reason_code(s) or reason" });
        continue;
      }
      const f = fit.get(recordId);
      const conflict = f ? fitRejectionConflict(f, codes.join(" "), reason) : null;
      if (conflict) {
        conflicts.push({ record_id: recordId, ...conflict });
        continue;
      }
    }
    items.push({
      record_id: recordId,
      decision,
      reason_codes: [...new Set(codes)],
      reason,
      retry_after: d.retry_after != null ? String(d.retry_after) : null,
      song_fit: fit.get(recordId) ?? null,
      verdict: d.verdict === "PASS" ? "PASS" : null,
    });
  }

  // Route boundary for records moving forward — same rule as batch review.
  let routeHeld: Record<string, unknown>[] = [];
  if (items.some((i) => i.decision === "reviewed")) {
    const hold = await holdFailingRecordsInBatch(sb, batchId, ops.label);
    if (!hold.ok) {
      return {
        status: hold.code === "migration_required" ? 503 : 500,
        data: { error: `route check blocked review: ${hold.error}`, code: hold.code ?? "route_check_failed" },
      };
    }
    routeHeld = hold.held;
  }

  if (!items.length) {
    return { status: 409, data: { ok: false, code: "no_applicable_decisions", conflicts, route_held: routeHeld } };
  }
  const attr = attributionFrom(ops);
  const { data, error } = await sb.rpc("agh_review_handoff_records", {
    p_batch_id: batchId,
    p_decisions: items,
    p_actor: attr.actor_kind,
    p_actor_label: attr.actor_label,
  });
  if (error) {
    const missing = /could not find|does not exist|PGRST202|42883/i.test(String(error.message));
    return {
      status: missing ? 503 : 500,
      data: {
        error: missing ? "agh_review_handoff_records RPC missing — apply migration 20260928120000" : error.message,
        code: missing ? "migration_required" : "rpc_failed",
      },
    };
  }
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    status: result.ok === false ? 422 : 200,
    data: { ...result, conflicts, route_held: routeHeld, route_held_count: routeHeld.length },
  };
}

/** Grok read path: batch + records with authoritative fit, route actionability and counts. */
export async function getHandoffBatchDetail(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const id = String(body.batch_id ?? body.id ?? "").trim();
  if (!id) return { status: 400, data: { error: "batch_id required" } };
  const { data: batch, error } = await sb.from("agh_handoff_batches").select("*").eq("id", id).maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!batch) return { status: 404, data: { error: "batch not found" } };
  if (!unscopedHandoffReader(ops) && batch.discovered_by && batch.discovered_by !== ops.kind) {
    return { status: 403, data: { error: "Cannot read another actor's handoff batch" } };
  }
  const { data: records, error: rErr } = await sb
    .from("agh_handoff_records")
    .select("*")
    .eq("batch_id", id)
    .order("created_at", { ascending: true });
  if (rErr) return { status: 500, data: { error: rErr.message } };
  const recs = (records ?? []) as Record<string, unknown>[];

  const pids = [...new Set(recs.map((r) => String(r.playlist_target_id ?? "")).filter(Boolean))];
  const targets = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < pids.length; i += 200) {
    const { data: t } = await sb
      .from("playlist_targets")
      .select("playlist_id, lane, contact_method, submission_method, curator_email, form_url, submission_url, ig_curator_account, curator_instagram, verification_status, path_verified, form_source_evidence, ig_source_evidence, submission_cost, form_login_required, is_active, research_context")
      .in("playlist_id", pids.slice(i, i + 200));
    for (const row of (t ?? []) as Record<string, unknown>[]) targets.set(String(row.playlist_id), row);
  }
  const draftIds = recs.map((r) => String(r.outreach_draft_id ?? "")).filter(Boolean);
  const drafts = new Map<string, Record<string, unknown>>();
  if (draftIds.length) {
    const { data: d } = await sb.from("outreach_drafts").select("id, status, pitch_log_id").in("id", draftIds);
    for (const row of (d ?? []) as Record<string, unknown>[]) drafts.set(String(row.id), row);
    // Delivery evidence is the provider message id on pitch_log, not the draft status.
    const logIds = [...drafts.values()].map((x) => String(x.pitch_log_id ?? "")).filter(Boolean);
    if (logIds.length) {
      const { data: pl } = await sb.from("pitch_log").select("id, resend_message_id").in("id", logIds);
      const byLog = new Map(((pl ?? []) as Record<string, unknown>[]).map((x) => [String(x.id), x.resend_message_id]));
      for (const row of drafts.values()) row.resend_message_id = byLog.get(String(row.pitch_log_id ?? "")) ?? null;
    }
  }
  const fit = await fitForRecords(sb, recs);
  const counts: RecordCounts = {};
  for (const r of recs) counts[String(r.queue_state)] = (counts[String(r.queue_state)] ?? 0) + 1;

  const enriched = recs.map((r) => {
    const draft = drafts.get(String(r.outreach_draft_id ?? ""));
    return {
      ...r,
      song_fit: fit.get(String(r.id)) ?? null,
      route_actionability: routeActionability(targets.get(String(r.playlist_target_id ?? "")) ?? null, r, {
        emailSent: draft ? ["sent", "sent_audit_broken"].includes(String(draft.status)) : false,
        emailProviderId: draft?.resend_message_id != null ? String(draft.resend_message_id) : null,
      }),
    };
  });
  return {
    status: 200,
    data: {
      ok: true,
      batch,
      batch_status: batchStatusSummary(String(batch.queue_state), counts),
      records: enriched,
      review_note:
        "Fit is decided by song_fit (lane vs the song's current approved Song DNA). DNA primary_genre is a broad " +
        "genre family, not a lane. Use review_handoff_records to decide per record.",
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
    case "advance_claude_ready_batches":
      return advanceClaudeReadyBatches(sb, body, ops);
    case "review_handoff_batch":
      return reviewHandoffBatch(sb, body, ops);
    case "list_handoff_batches": {
      const limit = Math.min(Number(body.limit) || 40, 100);
      const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
      // oldest_first lets a reviewer drain a backlog without older batches falling off
      // the first page (a newest-first page of 40 hides the oldest pending work).
      const oldestFirst = String(body.order ?? "").toLowerCase() === "oldest_first";
      let q = sb
        .from("agh_handoff_batches")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: oldestFirst });
      q = offset > 0 ? q.range(offset, offset + limit - 1) : q.limit(limit);
      if (typeof body.queue_state === "string") q = q.eq("queue_state", body.queue_state);
      if (typeof body.batch_kind === "string") q = q.eq("batch_kind", body.batch_kind);
      if (!unscopedHandoffReader(ops)) {
        q = q.eq("discovered_by", ops.kind);
      }
      const { data, error, count } = await q;
      if (error) return { status: 500, data: { error: error.message } };
      const rawRows = (data ?? []) as Record<string, unknown>[];
      // Record-level truth on every row: a batch state alone can hide mixed outcomes.
      const rc = await loadBatchRecordCounts(sb, rawRows.map((b) => String(b.id)));
      if (rc.error) return { status: 500, data: { error: `record_counts_failed:${rc.error}`, code: "db_error" } };
      const rows = rawRows.map((b) => ({
        ...b,
        batch_status: batchStatusSummary(String(b.queue_state), rc.counts.get(String(b.id)) ?? {}),
      }));
      const total = typeof count === "number" ? count : null;
      return {
        status: 200,
        data: {
          ok: true,
          rows,
          scoped: !unscopedHandoffReader(ops),
          total_count: total,
          offset,
          order: oldestFirst ? "oldest_first" : "newest_first",
          has_more: total != null ? offset + rows.length < total : rows.length === limit,
        },
      };
    }
    case "playlist_pipeline_report":
      return playlistPipelineReport(sb, body, ops);
    case "get_handoff_batch":
      return getHandoffBatchDetail(sb, body, ops);
    case "approve_handoff_records":
    case "reject_handoff_records":
      return reviewHandoffRecords(sb, { ...body, decisions: (Array.isArray(body.decisions) ? body.decisions : [])
        .map((d: Record<string, unknown>) => ({ ...d, decision: action === "approve_handoff_records" ? "approve" : "reject" })) }, ops);
    case "review_handoff_records":
      return reviewHandoffRecords(sb, body, ops);
    case "list_web_form_handoffs":
      return listWebFormHandoffs(sb, body, ops);
    case "mark_manual_form_submitted":
      return markManualFormSubmitted(sb, body, ops);
    case "mark_manual_ig_dm_submitted":
      return markManualIgDmSubmitted(sb, body, ops);
    case "materialize_email_handoff_drafts":
      return materializeEmailHandoffDrafts(sb, body, ops);
    default:
      return { status: 400, data: { error: `Unknown handoff action: ${action}` } };
  }
}

export { stampDiscover, stampDraft, stampReview };
