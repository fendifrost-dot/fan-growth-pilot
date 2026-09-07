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

/** Allowed single-step transitions (no skipping). */
export const HANDOFF_TRANSITIONS: Record<HandoffQueueState, readonly HandoffQueueState[]> = {
  CLAUDE_BATCH_READY: ["CLAUDE_PLAYLIST_COMPLETE", "AWAITING_GROK_REVIEW"],
  CLAUDE_PLAYLIST_COMPLETE: ["AWAITING_GROK_REVIEW"],
  AWAITING_GROK_REVIEW: ["GROK_REVIEWED", "APPROVED_FOR_SEND", "REJECTED_BY_GROK"],
  GROK_REVIEWED: ["APPROVED_FOR_SEND", "REJECTED_BY_GROK", "AWAITING_AGH_IMPORT"],
  APPROVED_FOR_SEND: ["AWAITING_AGH_IMPORT", "IMPORTED_TO_AGH"],
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

  // Final authority — never Claude, service, scheduler, or human_admin alone.
  if (ops.kind === "claude" || ops.kind === "service" || ops.kind === "scheduler") {
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

  if (clean.song_dna_version_id) {
    const dnaErr = await requireApprovedSongDna(sb, String(clean.song_dna_version_id));
    if (dnaErr) return { status: 422, data: { error: dnaErr, code: "dna_required" } };
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
    song_dna_version_id: clean.song_dna_version_id ? String(clean.song_dna_version_id) : null,
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
    .select("id, discovered_by, song_dna_version_id")
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

    const dnaId =
      (r.song_dna_version_id != null ? String(r.song_dna_version_id) : null) ||
      (batch.song_dna_version_id != null ? String(batch.song_dna_version_id) : null) ||
      (typeof r.packet === "object" && r.packet && (r.packet as Record<string, unknown>).song_dna_version_id != null
        ? String((r.packet as Record<string, unknown>).song_dna_version_id)
        : null);

    // Form / DM records always require approved Song DNA.
    if (channel === "web_form" || channel === "instagram_dm") {
      const dnaErr = await requireApprovedSongDna(sb, dnaId);
      if (dnaErr) return { status: 422, data: { error: dnaErr, code: "dna_required" } };
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
      playlist_target_id: r.playlist_target_id != null ? String(r.playlist_target_id) : null,
      outreach_draft_id: r.outreach_draft_id != null ? String(r.outreach_draft_id) : null,
      sync_target_id: r.sync_target_id != null ? String(r.sync_target_id) : null,
      sync_opportunity_id: r.sync_opportunity_id != null ? String(r.sync_opportunity_id) : null,
      submission_channel: channel,
      dedupe_key: r.dedupe_key != null ? String(r.dedupe_key) : null,
      song_dna_version_id: dnaId,
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
        allowed: isHandoffQueueState(from) ? HANDOFF_TRANSITIONS[from] : [],
      },
    };
  }

  const patch: Record<string, unknown> = {
    queue_state: next,
    updated_at: new Date().toISOString(),
  };
  // Attribution: additive stage stamps only — never overwrite discovered_by.
  if (next === "CLAUDE_PLAYLIST_COMPLETE" || next === "AWAITING_GROK_REVIEW") {
    if (!existing.drafted_by) Object.assign(patch, stampDraft(ops));
  }
  if (FINAL_AUTHORITY_STATES.has(next)) {
    Object.assign(patch, stampReview(ops));
  }
  if (next === "APPROVED_FOR_SEND") Object.assign(patch, stampApprove(ops));
  if (next === "REJECTED_BY_GROK") {
    Object.assign(patch, stampReject(ops));
    if (clean.rejection_reason != null) patch.notes = String(clean.rejection_reason);
  }

  const { data, error } = await sb
    .from("agh_handoff_batches")
    .update(patch)
    .eq("id", batchId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  // Records: update queue_state + review stamps only (preserve discovered_*/drafted_*).
  const recordPatch: Record<string, unknown> = {
    queue_state: next,
    updated_at: new Date().toISOString(),
  };
  if (FINAL_AUTHORITY_STATES.has(next)) Object.assign(recordPatch, stampReview(ops));
  if (next === "APPROVED_FOR_SEND") Object.assign(recordPatch, stampApprove(ops));
  if (next === "REJECTED_BY_GROK") Object.assign(recordPatch, stampReject(ops));
  await sb.from("agh_handoff_records").update(recordPatch).eq("batch_id", batchId);

  return { status: 200, data: { ok: true, batch: data } };
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
  if (ops.kind === "claude" || ops.kind === "service" || ops.kind === "human_admin") {
    return { status: 403, data: { error: `${ops.label} cannot act as final handoff authority` } };
  }
  const clean = stripSpoofedAttribution(body);
  const decision = String(clean.decision ?? "").trim().toLowerCase();
  let next: HandoffQueueState = "GROK_REVIEWED";
  if (decision === "approve") {
    if (!can(ops, "approve_playlist_drafts")) {
      return { status: 403, data: { error: `${ops.label} cannot approve handoff batches` } };
    }
    next = "APPROVED_FOR_SEND";
  } else if (decision === "reject") {
    if (!can(ops, "reject_playlist_drafts")) {
      return { status: 403, data: { error: `${ops.label} cannot reject handoff batches` } };
    }
    next = "REJECTED_BY_GROK";
  } else if (decision === "reviewed") {
    next = "GROK_REVIEWED";
  }
  return advanceHandoffBatch(sb, { ...clean, queue_state: next }, ops);
}

export async function markManualFormSubmitted(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  if (!can(ops, "send_playlist_pitches")) {
    return { status: 403, data: { error: `${ops.label} cannot mark form submissions` } };
  }
  if (ops.kind === "claude" || ops.kind === "service" || ops.kind === "human_admin") {
    return { status: 403, data: { error: `${ops.label} cannot mark form submissions as sent` } };
  }
  const clean = stripSpoofedAttribution(body);
  const playlistId = String(clean.playlist_id ?? clean.playlist_target_id ?? "").trim();
  if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
  const result = String(clean.result ?? "submitted").trim();
  const attr = attributionFrom(ops);
  const { data, error } = await sb
    .from("playlist_targets")
    .update({
      form_manual_submitted_at: new Date().toISOString(),
      form_manual_submit_result: result,
      form_manual_submitted_by: attr.actor_label,
      updated_at: new Date().toISOString(),
    })
    .eq("playlist_id", playlistId)
    .select("playlist_id, form_url, form_manual_submitted_at, form_manual_submit_result")
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!data) return { status: 404, data: { error: "playlist target not found" } };
  return { status: 200, data: { ok: true, row: data, automated_submit: false } };
}

export async function markManualIgDmSubmitted(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  if (!can(ops, "send_playlist_pitches") && !can(ops, "respond_to_curators")) {
    return { status: 403, data: { error: `${ops.label} cannot mark IG DM submissions` } };
  }
  if (ops.kind === "claude" || ops.kind === "service" || ops.kind === "human_admin") {
    return { status: 403, data: { error: `${ops.label} cannot mark IG DMs as sent` } };
  }
  const clean = stripSpoofedAttribution(body);
  const playlistId = String(clean.playlist_id ?? clean.playlist_target_id ?? "").trim();
  if (!playlistId) return { status: 400, data: { error: "playlist_id required" } };
  const responseStatus = String(clean.response_status ?? "submitted").trim();
  const attr = attributionFrom(ops);
  const { data, error } = await sb
    .from("playlist_targets")
    .update({
      ig_manual_submitted_at: new Date().toISOString(),
      ig_manual_response_status: responseStatus,
      ig_manual_submitted_by: attr.actor_label,
      updated_at: new Date().toISOString(),
    })
    .eq("playlist_id", playlistId)
    .select("playlist_id, ig_curator_account, ig_manual_submitted_at, ig_manual_response_status")
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!data) return { status: 404, data: { error: "playlist target not found" } };
  return { status: 200, data: { ok: true, row: data, bulk_dm: false, unattended_send: false } };
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
