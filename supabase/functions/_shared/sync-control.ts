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
import { resolveCurrentApprovedDna } from "./track-dna-envelope.ts";
import { outreachIdempotencyKey, sendProviderEmail } from "./provider-transport.ts";
import {
  defaultSyncPitchSubject,
  htmlToPlainText,
  pitchFromHeader,
} from "./resend-pitch.ts";
import { insertHubLicensingPitchLog } from "./sync-registers.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const SYNC_CONTROL_ACTIONS = [
  "review_sync_outreach",
  "approve_sync_outreach",
  "reject_sync_outreach",
  "submit_sync_outreach",
  "execute_sync_pitch",
  "record_manual_sync_outreach_submission",
  "track_sync_responses",
  "escalate_sync_to_fendi",
  "list_sync_pending_drafts",
] as const;

export function isSyncControlAction(action: string): boolean {
  return (SYNC_CONTROL_ACTIONS as readonly string[]).includes(action);
}

async function ensureLicensingPitchLogForHubSend(
  sb: SupabaseClient,
  args: {
    draft: Record<string, unknown>;
    trackName: string;
    contactName: string;
    contactEmail: string | null;
    company: string | null;
    supervisorId?: string | null;
    subject: string;
    emailBody: string;
    fromAddress: string;
    messageId: string;
    sentBy: string;
    sentByLabel: string;
    sentAt: string;
  },
): Promise<Record<string, unknown> | null> {
  const logged = await insertHubLicensingPitchLog(sb, {
    supervisor_id: args.supervisorId ?? null,
    contact_name: args.contactName,
    contact_email: args.contactEmail,
    company: args.company,
    track_id: args.draft.track_id ? String(args.draft.track_id) : null,
    track_name: args.trackName || "track",
    pitched_at: args.sentAt,
    approved_by: args.draft.approved_by ? String(args.draft.approved_by) : null,
    approved_by_label: args.draft.approved_by_label ? String(args.draft.approved_by_label) : null,
    approved_at: args.draft.approved_at ? String(args.draft.approved_at) : null,
    sent_by: args.sentBy,
    sent_by_label: args.sentByLabel,
    sent_at: args.sentAt,
    resend_message_id: args.messageId,
    draft_id: String(args.draft.id),
    subject: args.subject,
    email_body: args.emailBody,
    from_address: args.fromAddress,
    dispatched_via: "hub_resend",
  });
  if (!logged.ok) {
    console.error("licensing_pitch_log insert failed:", logged.error);
    return null;
  }
  return logged.row;
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
 * Submit approved outreach via a real transport.
 * Email: Resend. submitted/sent only after provider acceptance.
 * web_form / other: awaiting_manual_submission until Grok records external confirmation.
 */
export async function submitSyncOutreach(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "submit_sync_outreach");
  if (denied) return denied;
  if (ops.kind !== "grok_playlist_control" && ops.kind !== "fendi") {
    return {
      status: 403,
      data: {
        error: "Only Grok playlist-control or Fendi may submit sync outreach",
        code: "submit_actor_denied",
      },
    };
  }
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? clean.id ?? "").trim();
  if (!draftId) return { status: 400, data: { error: "draft_id required" } };
  const dryRun = Boolean(clean.dry_run);
  const testMode = Boolean(clean.test_mode);

  const channel = String(clean.submission_channel ?? "email").trim();
  if (channel !== "email" && channel !== "web_form") {
    return {
      status: 400,
      data: { error: "submission_channel must be email or web_form" },
    };
  }

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
  if (draft.status === "submitted" && draft.submission_message_id) {
    const replayFrom = pitchFromHeader();
    const { data: replayTrack } = await sb
      .from("tracks")
      .select("id, name")
      .eq("id", draft.track_id)
      .maybeSingle();
    const replayLog = await ensureLicensingPitchLogForHubSend(sb, {
      draft: draft as Record<string, unknown>,
      trackName: String(replayTrack?.name ?? "").trim(),
      contactName: String(draft.submitted_by_label ?? "sync contact"),
      contactEmail: null,
      company: null,
      subject: String(draft.subject ?? "").trim() || defaultSyncPitchSubject(String(replayTrack?.name ?? "")),
      emailBody: htmlToPlainText(String(draft.body ?? "")),
      fromAddress: replayFrom,
      messageId: String(draft.submission_message_id),
      sentBy: String(draft.submitted_by ?? "unknown"),
      sentByLabel: String(draft.submitted_by_label ?? "unknown"),
      sentAt: String(draft.submitted_at ?? new Date().toISOString()),
    });
    return {
      status: 200,
      data: {
        ok: true,
        draft,
        submitted: true,
        idempotent_replay: true,
        provider_message_id: draft.submission_message_id,
        from_address: replayFrom,
        licensing_pitch_log: replayLog,
      },
    };
  }
  if (draft.status !== "approved" && draft.status !== "send_failed") {
    return {
      status: 422,
      data: { error: "draft must be approved before submit", code: "not_approved", status: draft.status },
    };
  }

  const { data: opportunity } = await sb
    .from("sync_research_opportunities")
    .select("*")
    .eq("id", draft.opportunity_id)
    .maybeSingle();
  if (!opportunity) return { status: 404, data: { error: "opportunity not found" } };

  let target: Record<string, unknown> | null = null;
  if (opportunity.sync_target_id) {
    const { data: targetRow } = await sb
      .from("sync_research_targets")
      .select("*")
      .eq("id", opportunity.sync_target_id)
      .maybeSingle();
    target = targetRow;
  }
  const targetVerified =
    target != null &&
    (String(target.status ?? "") === "verified" ||
      Boolean(target.date_verified) ||
      Boolean(String(target.verified_contact_path ?? "").trim()));
  if (!targetVerified) {
    return {
      status: 422,
      data: { error: "verified sync target/opportunity required", code: "target_unverified" },
    };
  }

  const decision = await computeTrackSyncEligibility(sb, String(draft.track_id));
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  if (!decision.eligible) {
    return { status: 422, data: formatEligibilityBlock(decision) };
  }

  const dna = await resolveCurrentApprovedDna(sb, { trackId: String(draft.track_id) });
  if (!dna.ok || !dna.songDnaVersionId) {
    return {
      status: 422,
      data: { error: dna.errors[0] ?? "approved Song DNA required", code: "approved_dna_required" },
    };
  }

  const { data: currentSheet } = await sb
    .from("split_sheets")
    .select("id, version_number, document_hash, status, is_current")
    .eq("track_id", draft.track_id)
    .eq("is_current", true)
    .maybeSingle();

  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const idempotencyKey = String(draft.send_idempotency_key || "").trim() ||
    outreachIdempotencyKey({ kind: "sync-outreach", id: String(draft.id), channel });
  const fromAddress = pitchFromHeader();
  const { data: trackRow } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", draft.track_id)
    .maybeSingle();
  const trackName = String(trackRow?.name ?? "").trim();
  const companyName = String(target?.company_name ?? "").trim();
  const subject = String(draft.subject ?? "").trim() ||
    defaultSyncPitchSubject(trackName, companyName);
  const bodyText = htmlToPlainText(String(draft.body ?? ""));
  const recipientPreview = String(target?.verified_contact_path ?? "").trim();

  const binding = {
    track_id: draft.track_id,
    song_dna_version_id: dna.songDnaVersionId,
    opportunity_id: draft.opportunity_id,
    target_id: opportunity.sync_target_id,
    split_sheet_id: currentSheet?.id ?? null,
    split_sheet_version: currentSheet?.version_number ?? null,
    document_hash: currentSheet?.document_hash ?? null,
    rights_state: {
      sync_eligible: decision.eligible,
      blockers: decision.blockers,
    },
  };

  if (dryRun) {
    return {
      status: 200,
      data: {
        ok: true,
        dry_run: true,
        submitted: false,
        would_send: channel === "email" && recipientPreview.includes("@"),
        from_address: fromAddress,
        to: channel === "email" ? recipientPreview || null : null,
        subject,
        submission_channel: channel,
        binding,
        eligibility: decision,
        contractual_commitment: false,
        monetary_authority: false,
      },
    };
  }

  await sb.from("sync_research_pitch_drafts").update({
    send_idempotency_key: idempotencyKey,
    send_attempted_at: now,
    updated_at: now,
  }).eq("id", draftId);

  if (channel !== "email") {
    const { data: updated, error: uErr } = await sb
      .from("sync_research_pitch_drafts")
      .update({
        status: "awaiting_manual_submission",
        submission_channel: channel,
        send_idempotency_key: idempotencyKey,
        submission_evidence: "manual_packet_created",
        updated_at: now,
      })
      .eq("id", draftId)
      .select()
      .single();
    if (uErr) return { status: 500, data: { error: uErr.message } };
    return {
      status: 200,
      data: {
        ok: true,
        draft: updated,
        submitted: false,
        awaiting_manual_submission: true,
        packet: {
          ...binding,
          contact_path: target?.verified_contact_path ?? null,
          subject: draft.subject,
          body: draft.body,
        },
        contractual_commitment: false,
        monetary_authority: false,
        eligibility: decision,
      },
    };
  }

  const recipient = String(target?.verified_contact_path ?? "").trim();
  if (!recipient || !recipient.includes("@")) {
    return {
      status: 422,
      data: { error: "verified email contact path required for email outreach", code: "missing_recipient" },
    };
  }

  const send = await sendProviderEmail({
    to: [recipient],
    subject,
    text: bodyText,
    html: String(draft.body ?? "").trim() || bodyText.replace(/\n/g, "<br>"),
    idempotencyKey,
    forceTestMode: testMode,
  });

  if (!send.ok) {
    const { data: failed, error: failErr } = await sb
      .from("sync_research_pitch_drafts")
      .update({
        status: "send_failed",
        submission_channel: "email",
        send_idempotency_key: idempotencyKey,
        provider_response: { error: send.error, retryable: send.retryable },
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId)
      .select()
      .single();
    if (failErr) return { status: 500, data: { error: failErr.message } };
    return {
      status: 502,
      data: {
        ok: false,
        draft: failed,
        submitted: false,
        retryable: send.retryable,
        error: send.error,
        eligibility: decision,
      },
    };
  }

  const { data: updated, error: uErr } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "submitted",
      submitted_by: attr.actor_kind,
      submitted_by_label: attr.actor_label,
      submitted_at: now,
      submission_channel: "email",
      submission_evidence: "provider_accepted",
      submission_message_id: send.id,
      send_idempotency_key: idempotencyKey,
      provider_response: send.raw,
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

  let supervisorId: string | null = null;
  if (recipient) {
    const { data: sup } = await sb
      .from("music_supervisors")
      .select("id")
      .eq("email", recipient)
      .maybeSingle();
    if (sup?.id) supervisorId = String(sup.id);
  }
  const contactName =
    String(target?.person_name ?? "").trim() ||
    companyName ||
    recipient;
  const licensingLog = await ensureLicensingPitchLogForHubSend(sb, {
    draft: (updated ?? draft) as Record<string, unknown>,
    trackName,
    contactName,
    contactEmail: recipient,
    company: companyName || null,
    supervisorId,
    subject,
    emailBody: bodyText,
    fromAddress,
    messageId: send.id,
    sentBy: attr.actor_kind,
    sentByLabel: attr.actor_label,
    sentAt: now,
  });

  return {
    status: 200,
    data: {
      ok: true,
      draft: updated,
      submitted: true,
      submitted_at: now,
      submission_channel: "email",
      provider_message_id: send.id,
      from_address: fromAddress,
      licensing_pitch_log: licensingLog,
      binding,
      contractual_commitment: false,
      monetary_authority: false,
      eligibility: decision,
    },
  };
}

export async function recordManualSyncOutreachSubmission(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireCap(ops, "submit_sync_outreach");
  if (denied) return denied;
  if (ops.kind !== "grok_playlist_control" && ops.kind !== "fendi") {
    return { status: 403, data: { error: `${ops.label} may not record manual outreach submissions` } };
  }
  const clean = stripSpoofedAttribution(body);
  const draftId = String(clean.draft_id ?? "").trim();
  const evidence = String(clean.submission_evidence ?? "").trim();
  if (!draftId || !evidence) {
    return { status: 400, data: { error: "draft_id and submission_evidence required" } };
  }
  const { data: draft } = await sb
    .from("sync_research_pitch_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (!draft) return { status: 404, data: { error: "draft not found" } };
  if (draft.status !== "awaiting_manual_submission") {
    return {
      status: 409,
      data: { error: "draft is not awaiting manual submission", code: "not_manual_packet" },
    };
  }
  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("sync_research_pitch_drafts")
    .update({
      status: "submitted",
      submitted_by: attr.actor_kind,
      submitted_by_label: attr.actor_label,
      submitted_at: now,
      submission_evidence: evidence,
      updated_at: now,
    })
    .eq("id", draftId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, draft: data, submitted: true } };
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
    case "execute_sync_pitch":
      return submitSyncOutreach(sb, body, ops);
    case "record_manual_sync_outreach_submission":
      return recordManualSyncOutreachSubmission(sb, body, ops);
    case "track_sync_responses":
      return trackSyncResponses(sb, body, ops);
    case "escalate_sync_to_fendi":
      return escalateSyncToFendi(sb, body, ops);
    default:
      return { status: 400, data: { error: `Unknown sync control action: ${action}` } };
  }
}
