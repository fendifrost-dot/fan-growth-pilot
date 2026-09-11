/**
 * Grok sync-control lane — extends grok_playlist_control capabilities.
 * May review / approve / submit eligible-track outreach and track responses.
 * May NOT alter Song DNA, declare samples/rights, set Fendi sync approval,
 * make contractual commitments, or bypass sync eligibility.
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
import {
  computeTrackSyncEligibility,
  formatEligibilityBlock,
} from "./sync-eligibility.ts";
import { rejectCallerSyncIdentity } from "./sync-research-config.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const SYNC_CONTROL_ACTIONS = [
  "review_sync_outreach",
  "approve_sync_outreach",
  "reject_sync_outreach",
  "submit_sync_outreach",
  "track_sync_responses",
  "escalate_sync_to_fendi",
  "list_sync_pending_drafts",
] as const;

export function isSyncControlAction(action: string): boolean {
  return (SYNC_CONTROL_ACTIONS as readonly string[]).includes(action);
}

async function requireCap(ops: OpsActor, cap: Parameters<typeof can>[1]): Promise<RunResult | null> {
  if (!can(ops, cap)) {
    return { status: 403, data: { error: `${ops.label} is not permitted to ${cap}` } };
  }
  // Hard denials for Fendi-only domains even if a cap were mis-granted.
  for (const forbidden of [
    "approve_song_dna",
    "approve_sample_declaration",
    "approve_sync_eligibility",
    "alter_approved_song_dna",
    "authorize_monetary_decisions",
  ] as const) {
    if ((cap as string) === forbidden) {
      return { status: 403, data: { error: `${forbidden} is Fendi-only` } };
    }
  }
  return null;
}

export async function listSyncPendingDrafts(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "review_sync_outreach");
  if (denied) return denied;
  const status = String(body.status ?? "draft").trim();
  const limit = Math.min(Number(body.limit) || 50, 200);
  let q = sb
    .from("sync_research_pitch_drafts")
    .select("*, sync_research_opportunities(*)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status === "pending") {
    q = q.in("status", ["draft", "approved"]);
  } else {
    q = q.eq("status", status);
  }
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };

  // Also surface Claude sync batches awaiting Grok.
  const { data: batches } = await sb
    .from("agh_handoff_batches")
    .select("*")
    .eq("batch_kind", "sync")
    .eq("queue_state", "AWAITING_GROK_REVIEW")
    .order("created_at", { ascending: false })
    .limit(40);

  return {
    status: 200,
    data: {
      ok: true,
      drafts: data ?? [],
      awaiting_batches: batches ?? [],
      actor: ops.label,
    },
  };
}

export async function reviewSyncOutreach(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "review_sync_outreach");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  const batchId = String(clean.batch_id ?? "").trim();

  const notes: Record<string, unknown> = {
    source_valid: clean.source_valid !== false,
    fit_ok: clean.fit_ok !== false,
    contact_route_ok: clean.contact_route_ok !== false,
    duplicate: clean.duplicate === true,
    audit_notes: clean.audit_notes != null ? String(clean.audit_notes) : null,
    reviewed_at: new Date().toISOString(),
    reviewed_by: attributionFrom(ops).actor_kind,
  };

  if (draftId) {
    const { data: draft, error } = await sb
      .from("sync_research_pitch_drafts")
      .select("*")
      .eq("id", draftId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!draft) return { status: 404, data: { error: "draft not found" } };
    return { status: 200, data: { ok: true, draft, audit: notes } };
  }

  if (batchId) {
    const { data: batch, error } = await sb
      .from("agh_handoff_batches")
      .select("*")
      .eq("id", batchId)
      .eq("batch_kind", "sync")
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!batch) return { status: 404, data: { error: "batch not found" } };
    const attr = attributionFrom(ops);
    const { data: updated, error: uErr } = await sb
      .from("agh_handoff_batches")
      .update({
        queue_state: "GROK_REVIEWED",
        reviewed_by: attr.actor_kind,
        reviewed_by_label: attr.actor_label,
        payload: {
          ...((batch.payload as Record<string, unknown>) ?? {}),
          grok_audit: notes,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .select()
      .single();
    if (uErr) return { status: 500, data: { error: uErr.message } };
    return { status: 200, data: { ok: true, batch: updated, audit: notes } };
  }

  return { status: 400, data: { error: "draft_id or batch_id required" } };
}

export async function approveSyncOutreach(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "approve_sync_outreach");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };

  const { data: draft, error } = await sb
    .from("sync_research_pitch_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!draft) return { status: 404, data: { error: "draft not found" } };

  const decision = await computeTrackSyncEligibility(sb, String(draft.track_id));
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  if (!decision.eligible) {
    return { status: 422, data: formatEligibilityBlock(decision) };
  }

  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "approved",
      approved_by: attr.actor_kind,
      approved_by_label: attr.actor_label,
      approved_at: now,
      updated_at: now,
    })
    .eq("id", draftId)
    .select()
    .single();
  if (uErr) return { status: 500, data: { error: uErr.message } };

  if (draft.batch_id) {
    await sb
      .from("agh_handoff_batches")
      .update({
        queue_state: "APPROVED_FOR_SEND",
        approved_by: attr.actor_kind,
        approved_by_label: attr.actor_label,
        approved_count: undefined, // leave count; bump below via rpc-less increment
        updated_at: now,
      })
      .eq("id", draft.batch_id);
    const { data: batch } = await sb
      .from("agh_handoff_batches")
      .select("approved_count")
      .eq("id", draft.batch_id)
      .maybeSingle();
    if (batch) {
      await sb
        .from("agh_handoff_batches")
        .update({ approved_count: Number(batch.approved_count ?? 0) + 1 })
        .eq("id", draft.batch_id);
    }
  }

  return {
    status: 200,
    data: {
      ok: true,
      draft: updated,
      contractual_commitment: false,
      monetary_authority: false,
      eligibility: decision,
    },
  };
}

export async function rejectSyncOutreach(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "reject_sync_outreach");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };
  const reason = String(clean.rejection_reason ?? clean.reason ?? "").trim() || "rejected_by_grok";
  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "rejected",
      rejected_by: attr.actor_kind,
      rejected_by_label: attr.actor_label,
      rejected_at: now,
      rejection_reason: reason,
      updated_at: now,
    })
    .eq("id", draftId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  if (data.batch_id) {
    const { data: batch } = await sb
      .from("agh_handoff_batches")
      .select("rejected_count")
      .eq("id", data.batch_id)
      .maybeSingle();
    await sb
      .from("agh_handoff_batches")
      .update({
        rejected_by: attr.actor_kind,
        rejected_by_label: attr.actor_label,
        rejected_count: Number(batch?.rejected_count ?? 0) + 1,
        updated_at: now,
      })
      .eq("id", data.batch_id);
  }

  return { status: 200, data: { ok: true, draft: data } };
}

/**
 * Submit approved outreach via supported channels.
 * Logs evidence only — does not invent sends. Email path records intent + timestamp;
 * actual Resend wiring remains operator-gated and eligibility-bound.
 */
export async function submitSyncOutreach(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "submit_sync_outreach");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };

  const channel = String(clean.submission_channel ?? "email").trim();
  if (channel !== "email" && channel !== "web_form") {
    return {
      status: 400,
      data: { error: "submission_channel must be email or web_form" },
    };
  }

  // Reject caller subject/body overrides on submit — use approved draft content.
  if (clean.subject !== undefined || clean.body !== undefined) {
    return {
      status: 400,
      data: {
        error: "subject/body overrides prohibited on submit — use approved draft content",
        code: "caller_copy_override_rejected",
      },
    };
  }

  const { data: draft, error } = await sb
    .from("sync_research_pitch_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!draft) return { status: 404, data: { error: "draft not found" } };
  if (draft.status !== "approved") {
    return {
      status: 422,
      data: { error: "draft must be approved before submit", code: "not_approved", status: draft.status },
    };
  }

  const decision = await computeTrackSyncEligibility(sb, String(draft.track_id));
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  if (!decision.eligible) {
    return { status: 422, data: formatEligibilityBlock(decision) };
  }

  const evidence = String(clean.submission_evidence ?? "").trim() ||
    `submitted_via_${channel}_at_${new Date().toISOString()}`;
  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "submitted",
      submitted_by: attr.actor_kind,
      submitted_by_label: attr.actor_label,
      submitted_at: now,
      submission_channel: channel,
      submission_evidence: evidence,
      submission_message_id: clean.submission_message_id != null
        ? String(clean.submission_message_id)
        : null,
      updated_at: now,
    })
    .eq("id", draftId)
    .select()
    .single();
  if (uErr) return { status: 500, data: { error: uErr.message } };

  await sb
    .from("sync_research_opportunities")
    .update({ status: "submitted", updated_at: now })
    .eq("id", draft.opportunity_id);

  if (draft.batch_id) {
    const { data: batch } = await sb
      .from("agh_handoff_batches")
      .select("submitted_count")
      .eq("id", draft.batch_id)
      .maybeSingle();
    await sb
      .from("agh_handoff_batches")
      .update({
        sent_by: attr.actor_kind,
        sent_by_label: attr.actor_label,
        submitted_count: Number(batch?.submitted_count ?? 0) + 1,
        updated_at: now,
      })
      .eq("id", draft.batch_id);
  }

  return {
    status: 200,
    data: {
      ok: true,
      draft: updated,
      submitted_at: now,
      submission_channel: channel,
      contractual_commitment: false,
      monetary_authority: false,
      eligibility: decision,
    },
  };
}

export async function trackSyncResponses(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "track_sync_responses");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };
  const responseStatus = String(clean.response_status ?? "").trim();
  if (!responseStatus) {
    return { status: 400, data: { error: "response_status required" } };
  }
  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "awaiting_response",
      response_status: responseStatus,
      response_notes: clean.response_notes != null ? String(clean.response_notes) : null,
      response_checked_at: now,
      response_checked_by: attr.actor_kind,
      response_checked_by_label: attr.actor_label,
      updated_at: now,
    })
    .eq("id", draftId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  if (data.batch_id) {
    const { data: batch } = await sb
      .from("agh_handoff_batches")
      .select("response_count")
      .eq("id", data.batch_id)
      .maybeSingle();
    await sb
      .from("agh_handoff_batches")
      .update({
        response_checked_by: attr.actor_kind,
        response_checked_by_label: attr.actor_label,
        response_count: Number(batch?.response_count ?? 0) + 1,
        updated_at: now,
      })
      .eq("id", data.batch_id);
  }

  return { status: 200, data: { ok: true, draft: data } };
}

export async function escalateSyncToFendi(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "escalate_sync_to_fendi");
  if (denied) return denied;
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };
  const reason = String(clean.escalation_reason ?? clean.reason ?? "").trim();
  if (!reason) {
    return {
      status: 400,
      data: {
        error:
          "escalation_reason required (contracts, exclusivity, rights conflicts, creative changes, money, licensing)",
      },
    };
  }
  // Grok escalates — never commits.
  const { data, error } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      escalated_to_fendi: true,
      escalation_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };
  return {
    status: 200,
    data: {
      ok: true,
      draft: data,
      contractual_commitment: false,
      monetary_authority: false,
      awaiting_fendi: true,
    },
  };
}

export async function runSyncControlAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case "list_sync_pending_drafts":
      return listSyncPendingDrafts(sb, body, ops);
    case "review_sync_outreach":
      return reviewSyncOutreach(sb, body, ops);
    case "approve_sync_outreach":
      return approveSyncOutreach(sb, body, ops);
    case "reject_sync_outreach":
      return rejectSyncOutreach(sb, body, ops);
    case "submit_sync_outreach":
      return submitSyncOutreach(sb, body, ops);
    case "track_sync_responses":
      return trackSyncResponses(sb, body, ops);
    case "escalate_sync_to_fendi":
      return escalateSyncToFendi(sb, body, ops);
    default:
      return { status: 400, data: { error: `Unknown sync control action: ${action}` } };
  }
}
