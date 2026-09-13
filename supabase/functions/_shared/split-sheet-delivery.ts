/**
 * Split-sheet delivery to sync contacts.
 *
 * Default policy: request_only. Never auto-attach on initial sync pitch.
 * Grok (+ Fendi) may view availability, request Fendi authorization, deliver
 * approved final docs, and log delivery. Claude may not deliver.
 * Grok may NOT edit shares, finalize, impersonate Fendi, or deliver
 * draft / superseded / disputed sheets.
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
  DOCUMENT_KINDS,
  RIGHTS_DOCUMENTS_BUCKET,
  computeDocumentHash,
  type DocumentKind,
  type Result,
} from "./split-sheets.ts";
import { outreachIdempotencyKey, sendProviderEmail, utf8ToBase64 } from "./provider-transport.ts";

export const SPLIT_SHEET_DELIVERY_ACTIONS = [
  "get_split_sheet_delivery_availability",
  "request_split_sheet_delivery_authorization",
  "grant_split_sheet_delivery_authorization",
  "deliver_split_sheet_to_sync_contact",
  "list_split_sheet_deliveries",
  "record_split_sheet_delivery_response",
  "record_manual_split_sheet_submission",
] as const;

export function isSplitSheetDeliveryAction(action: string): boolean {
  return (SPLIT_SHEET_DELIVERY_ACTIONS as readonly string[]).includes(action);
}

export const DELIVERY_REASONS = [
  "recipient_requested",
  "opportunity_requires",
  "fendi_authorized",
] as const;
export type DeliveryReason = (typeof DELIVERY_REASONS)[number];

/** All honest document kinds are deliverable only when status=final & current. */
const ALLOWED_DELIVERY_DOCUMENT_KINDS = new Set<string>(DOCUMENT_KINDS);

function cleanBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = stripSpoofedAttribution(body);
  for (const key of [
    "fendi_approved_by",
    "finalized_by",
    "approved_by",
    "delivered_by",
    "delivered_by_label",
  ]) {
    delete out[key];
  }
  return out;
}

function isClaudeKind(ops: OpsActor): boolean {
  return (
    ops.kind === "claude" ||
    ops.kind === "claude_sync_discovery" ||
    ops.kind === "claude_playlist_discovery"
  );
}

function canDeliver(ops: OpsActor): boolean {
  return ops.kind === "grok_playlist_control" || ops.kind === "fendi";
}

function denyClaudeDelivery(ops: OpsActor): Result | null {
  if (isClaudeKind(ops)) {
    return {
      status: 403,
      data: {
        error: "Claude may not deliver split sheets or change delivery eligibility",
        code: "claude_delivery_denied",
      },
    };
  }
  return null;
}

/** Ordinary first-contact pitches must never attach the full sheet. */
export function shouldAttachSplitSheetToInitialPitch(_opts?: {
  policy?: string | null;
  opportunity_requires?: boolean;
}): boolean {
  return false;
}

async function loadDeliveryPolicy(
  sb: SupabaseClient,
  trackId?: string | null,
): Promise<{
  default: string;
  allow_auto_attach_on_initial_pitch: boolean;
  secure_link_ttl_seconds: number;
  track_policy: string;
}> {
  let trackPolicy = "request_only";
  if (trackId) {
    const { data: track } = await sb
      .from("tracks")
      .select("split_sheet_delivery_policy")
      .eq("id", trackId)
      .maybeSingle();
    if (track?.split_sheet_delivery_policy) {
      trackPolicy = String(track.split_sheet_delivery_policy);
    }
  }
  const { data: setting } = await sb
    .from("ops_settings")
    .select("setting_value")
    .eq("setting_key", "split_sheet_delivery_policy")
    .maybeSingle();
  const val = (setting?.setting_value ?? {}) as Record<string, unknown>;
  return {
    default: String(val.default ?? "request_only"),
    allow_auto_attach_on_initial_pitch: val.allow_auto_attach_on_initial_pitch === true,
    secure_link_ttl_seconds: Number(val.secure_link_ttl_seconds) || 900,
    track_policy: trackPolicy,
  };
}

function sheetDeliverable(sheet: Record<string, unknown>): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (String(sheet.status) !== "final") reasons.push("status_not_final");
  if (sheet.is_current !== true) reasons.push("not_current");
  if (String(sheet.status) === "disputed") reasons.push("disputed");
  if (String(sheet.status) === "superseded") reasons.push("superseded");
  const kind = String(sheet.document_kind ?? "");
  if (!ALLOWED_DELIVERY_DOCUMENT_KINDS.has(kind)) {
    reasons.push("document_kind_not_allowed");
  }
  // Reject unsigned HTML mislabeled as signed is handled at finalize; here require known kind.
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) {
    reasons.push("document_kind_unknown");
  }
  return { ok: reasons.length === 0, reasons };
}

async function findPriorFendiAuthorization(
  sb: SupabaseClient,
  trackId: string,
  splitSheetId: string,
): Promise<boolean> {
  const { data } = await sb
    .from("rights_document_audit_events")
    .select("id, detail, actor_kind, event_kind")
    .eq("track_id", trackId)
    .eq("split_sheet_id", splitSheetId)
    .eq("event_kind", "delivery")
    .order("created_at", { ascending: false })
    .limit(40);
  for (const row of data ?? []) {
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    if (
      detail.phase === "authorization_granted" &&
      (row.actor_kind === "fendi" || detail.granted_by_kind === "fendi")
    ) {
      return true;
    }
  }
  return false;
}

export async function runSplitSheetDeliveryAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null = null,
  req: Request | null = null,
): Promise<Result> {
  const ops = resolveOpsActor(actor, req);
  const clean = cleanBody(body);
  const claudeDeny = denyClaudeDelivery(ops);
  if (claudeDeny) return claudeDeny;

  switch (action) {
    case "get_split_sheet_delivery_availability": {
      if (!canDeliver(ops) && ops.kind !== "human_admin") {
        return {
          status: 403,
          data: { error: `${ops.label} may not view split-sheet delivery availability` },
        };
      }
      const trackId = String(clean.track_id ?? "").trim();
      if (!trackId) return { status: 400, data: { error: "track_id required" } };
      const policy = await loadDeliveryPolicy(sb, trackId);
      const { data: track } = await sb
        .from("tracks")
        .select(
          "id, name, splits_ready, splits_ready_source, current_split_sheet_id, split_sheet_delivery_policy",
        )
        .eq("id", trackId)
        .maybeSingle();
      if (!track) return { status: 404, data: { error: "Track not found" } };

      let sheet: Record<string, unknown> | null = null;
      if (track.current_split_sheet_id) {
        const { data } = await sb
          .from("split_sheets")
          .select(
            "id, status, is_current, document_kind, document_hash, version_number, document_storage_path, title",
          )
          .eq("id", track.current_split_sheet_id)
          .maybeSingle();
        sheet = data;
      }
      const deliverable = sheet
        ? sheetDeliverable(sheet)
        : { ok: false, reasons: ["no_current_sheet"] };
      const priorAuth = sheet
        ? await findPriorFendiAuthorization(sb, trackId, String(sheet.id))
        : false;

      return {
        status: 200,
        data: {
          ok: true,
          track,
          sheet,
          deliverable: deliverable.ok,
          blockers: deliverable.reasons,
          delivery_policy: policy.track_policy || policy.default,
          allow_auto_attach_on_initial_pitch: false,
          should_attach_to_initial_pitch: shouldAttachSplitSheetToInitialPitch(),
          prior_fendi_authorization: priorAuth,
          actor: ops.label,
        },
      };
    }

    case "request_split_sheet_delivery_authorization": {
      if (!can(ops, "request_split_sheet_delivery_authorization") && !canDeliver(ops) &&
        ops.kind !== "human_admin") {
        return {
          status: 403,
          data: { error: `${ops.label} may not request delivery authorization` },
        };
      }
      // Grant must use grant_split_sheet_delivery_authorization (Fendi-only).
      if (clean.authorize === true || clean.grant === true) {
        return {
          status: 400,
          data: {
            error:
              "Use grant_split_sheet_delivery_authorization to grant; this action only requests",
            code: "use_grant_action",
          },
        };
      }
      const trackId = String(clean.track_id ?? "").trim();
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      if (!trackId || !sheetId) {
        return { status: 400, data: { error: "track_id and split_sheet_id required" } };
      }
      const reason = String(clean.reason ?? clean.request_reason ?? "").trim();
      const attr = attributionFrom(ops);
      await sb.from("rights_document_audit_events").insert({
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "delivery",
        actor_kind: attr.actor_kind,
        actor_label: attr.actor_label,
        actor_user_id: attr.actor_user_id,
        detail: {
          phase: "authorization_request",
          reason: reason || null,
          sync_target_id: clean.sync_target_id ?? null,
          sync_opportunity_id: clean.sync_opportunity_id ?? null,
          awaiting_fendi: true,
        },
      });
      return {
        status: 200,
        data: {
          ok: true,
          requested: true,
          awaiting_fendi: true,
          requested_by: attr.actor_label,
        },
      };
    }

    case "grant_split_sheet_delivery_authorization": {
      if (ops.kind !== "fendi" || !can(ops, "authorize_split_sheet_delivery")) {
        return {
          status: 403,
          data: {
            error: "Only Fendi may grant split-sheet delivery authorization",
            code: "fendi_only",
          },
        };
      }
      const trackId = String(clean.track_id ?? "").trim();
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      if (!trackId || !sheetId) {
        return { status: 400, data: { error: "track_id and split_sheet_id required" } };
      }
      const reason = String(clean.reason ?? clean.grant_reason ?? "").trim();
      const attr = attributionFrom(ops);
      await sb.from("rights_document_audit_events").insert({
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "delivery",
        actor_kind: attr.actor_kind,
        actor_label: attr.actor_label,
        actor_user_id: attr.actor_user_id,
        detail: {
          phase: "authorization_granted",
          granted_by_kind: "fendi",
          reason: reason || null,
          sync_target_id: clean.sync_target_id ?? null,
          sync_opportunity_id: clean.sync_opportunity_id ?? null,
        },
      });
      return {
        status: 200,
        data: { ok: true, authorized: true, granted_by: attr.actor_label },
      };
    }

    case "deliver_split_sheet_to_sync_contact": {
      if (!canDeliver(ops)) {
        return {
          status: 403,
          data: {
            error: "Only Grok playlist-control or Fendi may deliver split sheets",
            code: "delivery_actor_denied",
          },
        };
      }
      const trackId = String(clean.track_id ?? "").trim();
      const sheetId = String(clean.split_sheet_id ?? "").trim();
      const deliveryReason = String(clean.delivery_reason ?? "").trim() as DeliveryReason;
      if (!trackId || !sheetId) {
        return { status: 400, data: { error: "track_id and split_sheet_id required" } };
      }
      if (!(DELIVERY_REASONS as readonly string[]).includes(deliveryReason)) {
        return {
          status: 400,
          data: {
            error:
              "delivery_reason required: recipient_requested | opportunity_requires | fendi_authorized",
          },
        };
      }

      const policy = await loadDeliveryPolicy(sb, trackId);
      const effectivePolicy = policy.track_policy || policy.default || "request_only";

      // request_only: require explicit reason; fendi_authorized needs Fendi actor or prior grant.
      if (effectivePolicy === "request_only") {
        if (!deliveryReason) {
          return { status: 400, data: { error: "delivery_reason required under request_only" } };
        }
        if (deliveryReason === "fendi_authorized") {
          const prior = await findPriorFendiAuthorization(sb, trackId, sheetId);
          if (ops.kind !== "fendi" && !prior) {
            return {
              status: 403,
              data: {
                error:
                  "fendi_authorized delivery requires Fendi actor or prior Fendi authorization row",
                code: "fendi_authorization_required",
              },
            };
          }
        }
      }

      const { data: sheet } = await sb.from("split_sheets").select("*").eq("id", sheetId)
        .maybeSingle();
      if (!sheet) return { status: 404, data: { error: "split sheet not found" } };
      if (String(sheet.track_id) !== trackId) {
        return { status: 400, data: { error: "track_id does not match sheet" } };
      }
      const deliverable = sheetDeliverable(sheet as Record<string, unknown>);
      if (!deliverable.ok) {
        return {
          status: 422,
          data: {
            error: "sheet not deliverable",
            code: "not_deliverable",
            blockers: deliverable.reasons,
          },
        };
      }

      const path = String(sheet.document_storage_path ?? "").trim();
      const documentHash = String(sheet.document_hash ?? "");
      if (!documentHash || !path) {
        return {
          status: 422,
          data: { error: "final stored document + hash required before delivery", code: "missing_hash" },
        };
      }
      if (String(sheet.generated_html ?? "").trim()) {
        const liveHash = await computeDocumentHash(String(sheet.generated_html));
        if (liveHash !== documentHash) {
          return {
            status: 409,
            data: { error: "stored document hash mismatch", code: "hash_mismatch" },
          };
        }
      }

      const { data: verifiedEv } = await sb
        .from("split_sheet_evidence")
        .select("id")
        .eq("split_sheet_id", sheetId)
        .eq("verification_status", "verified")
        .limit(1);
      const kind = String(sheet.document_kind ?? "");
      if ((kind === "uploaded_signed" || kind === "provider_signed" || kind === "verified_signed") &&
        !(verifiedEv ?? []).length) {
        return {
          status: 422,
          data: { error: "verified evidence required for signed-document delivery", code: "evidence_unverified" },
        };
      }

      const prior = await findPriorFendiAuthorization(sb, trackId, sheetId);
      if (ops.kind !== "fendi" && !prior) {
        return {
          status: 403,
          data: {
            error: "Grok must request and Fendi must grant delivery authorization before transport",
            code: "fendi_authorization_required",
          },
        };
      }
      if (effectivePolicy === "proactive_allowed") {
        if (!clean.sync_opportunity_id) {
          return {
            status: 422,
            data: { error: "proactive delivery requires sync_opportunity_id", code: "opportunity_required" },
          };
        }
      }

      const channel = String(clean.delivery_channel ?? "email");
      const attr = attributionFrom(ops);
      const idempotencyKey = outreachIdempotencyKey({
        kind: "split_delivery",
        id: `${sheetId}:${clean.sync_opportunity_id ?? clean.recipient_email ?? "manual"}`,
        channel,
      });
      const { data: existing } = await sb
        .from("split_sheet_deliveries")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing && existing.delivery_result === "sent") {
        return { status: 200, data: { ok: true, delivery: existing, idempotent_replay: true } };
      }

      if (channel === "web_form") {
        const { data: delivery, error } = await sb.from("split_sheet_deliveries").insert({
          track_id: trackId,
          split_sheet_id: sheetId,
          sync_target_id: clean.sync_target_id ? String(clean.sync_target_id) : null,
          sync_opportunity_id: clean.sync_opportunity_id ? String(clean.sync_opportunity_id) : null,
          recipient_name: clean.recipient_name != null ? String(clean.recipient_name) : null,
          recipient_email: clean.recipient_email != null ? String(clean.recipient_email) : null,
          recipient_organization: clean.recipient_organization != null
            ? String(clean.recipient_organization)
            : null,
          delivery_reason: deliveryReason,
          delivery_channel: "web_form",
          document_version: Number(sheet.version_number ?? 1),
          document_hash: documentHash,
          document_kind: String(sheet.document_kind),
          document_storage_path: path,
          delivered_by: attr.actor_kind,
          delivered_by_label: attr.actor_label,
          requested_by: attr.actor_label,
          authorized_by: prior || ops.kind === "fendi" ? "fendi" : null,
          approval_identity: ops.kind === "fendi" ? attr.actor_label : null,
          approval_required: true,
          delivery_result: "awaiting_manual_submission",
          idempotency_key: idempotencyKey,
        }).select("*").single();
        if (error) return { status: 500, data: { error: error.message } };
        await sb.from("rights_document_audit_events").insert({
          track_id: trackId,
          split_sheet_id: sheetId,
          event_kind: "delivery",
          actor_kind: attr.actor_kind,
          actor_label: attr.actor_label,
          actor_user_id: attr.actor_user_id,
          document_hash: documentHash,
          detail: { phase: "manual_packet", delivery_id: delivery.id, sent: false },
        });
        return {
          status: 200,
          data: {
            ok: true,
            delivery,
            delivery_result: "awaiting_manual_submission",
            sent: false,
            note: "Manual packet only. Record the external submission with record_manual_split_sheet_submission.",
          },
        };
      }

      if (channel !== "email") {
        return { status: 400, data: { error: "delivery_channel must be email or web_form" } };
      }
      const recipient = String(clean.recipient_email ?? "").trim();
      if (!recipient) {
        return { status: 400, data: { error: "recipient_email required for email delivery" } };
      }

      const ttl = Math.min(
        Math.max(Number(clean.ttl_seconds) || policy.secure_link_ttl_seconds || 900, 60),
        3600,
      );
      let attachmentContent: string | null = null;
      if (sheet.generated_html) {
        attachmentContent = utf8ToBase64(String(sheet.generated_html));
      }
      let signedUrl: string | null = null;
      let secureExpires: string | null = null;
      if (!attachmentContent && path) {
        const { data: signed, error: sErr } = await sb.storage
          .from(RIGHTS_DOCUMENTS_BUCKET)
          .createSignedUrl(path, ttl);
        if (!sErr) {
          signedUrl = signed?.signedUrl ?? null;
          secureExpires = new Date(Date.now() + ttl * 1000).toISOString();
        }
      }

      if (!attachmentContent && !signedUrl) {
        return {
          status: 422,
          data: {
            error: "cannot deliver without stored document bytes or a short-lived authenticated link",
            code: "delivery_payload_missing",
          },
        };
      }

      const bodyText = attachmentContent
        ? "Confidential ownership document attached. Do not forward. This is not a public URL."
        : `Confidential ownership document (short-lived authenticated download; not a public URL):\n${signedUrl}`;

      const send = await sendProviderEmail({
        to: [recipient],
        subject: "Confidential ownership document",
        text: bodyText,
        html: `<p>${bodyText.replace(/\n/g, "<br>")}</p>`,
        idempotencyKey,
        attachments: attachmentContent
          ? [{ filename: "ownership-summary.html", content: attachmentContent, contentType: "text/html" }]
          : undefined,
      });

      const { data: delivery, error } = await sb
        .from("split_sheet_deliveries")
        .insert({
          track_id: trackId,
          split_sheet_id: sheetId,
          sync_target_id: clean.sync_target_id ? String(clean.sync_target_id) : null,
          sync_opportunity_id: clean.sync_opportunity_id
            ? String(clean.sync_opportunity_id)
            : null,
          recipient_name: clean.recipient_name != null ? String(clean.recipient_name) : null,
          recipient_email: recipient,
          recipient_organization: clean.recipient_organization != null
            ? String(clean.recipient_organization)
            : null,
          delivery_reason: deliveryReason,
          delivery_channel: "email",
          document_version: Number(sheet.version_number ?? 1),
          document_hash: documentHash,
          document_kind: String(sheet.document_kind),
          document_storage_path: path,
          secure_link_expires_at: secureExpires,
          delivered_by: attr.actor_kind,
          delivered_by_label: attr.actor_label,
          requested_by: attr.actor_label,
          authorized_by: prior || ops.kind === "fendi" ? "fendi" : null,
          approval_identity: ops.kind === "fendi" ? attr.actor_label : null,
          approval_required: true,
          delivery_result: send.ok ? "sent" : "failed",
          delivery_error: send.ok ? null : send.error,
          provider_message_id: send.ok ? send.id : null,
          provider_response: send.ok ? send.raw : { error: send.error },
          idempotency_key: idempotencyKey,
        })
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };

      await sb.from("rights_document_audit_events").insert({
        track_id: trackId,
        split_sheet_id: sheetId,
        event_kind: "delivery",
        actor_kind: attr.actor_kind,
        actor_label: attr.actor_label,
        actor_user_id: attr.actor_user_id,
        document_hash: documentHash,
        detail: {
          phase: send.ok ? "provider_accepted" : "provider_failed",
          delivery_id: delivery.id,
          delivery_reason: deliveryReason,
          provider_message_id: send.ok ? send.id : null,
          minted_signed_url: Boolean(signedUrl),
        },
      });

      return {
        status: send.ok ? 200 : 502,
        data: {
          ok: send.ok,
          delivery,
          sent: send.ok,
          delivery_result: send.ok ? "sent" : "failed",
          provider_message_id: send.ok ? send.id : null,
          retryable: send.ok ? false : send.retryable,
          document_kind: sheet.document_kind,
          document_hash: documentHash,
          auto_attached_to_pitch: false,
        },
      };
    }

    case "record_manual_split_sheet_submission": {
      if (!canDeliver(ops)) {
        return { status: 403, data: { error: `${ops.label} may not record manual submissions` } };
      }
      const deliveryId = String(clean.delivery_id ?? "").trim();
      const evidence = String(clean.submission_evidence ?? "").trim();
      if (!deliveryId || !evidence) {
        return { status: 400, data: { error: "delivery_id and submission_evidence required" } };
      }
      const { data: row } = await sb.from("split_sheet_deliveries").select("*")
        .eq("id", deliveryId).maybeSingle();
      if (!row) return { status: 404, data: { error: "delivery not found" } };
      if (row.delivery_result !== "awaiting_manual_submission") {
        return {
          status: 409,
          data: { error: "delivery is not awaiting manual submission", code: "not_manual_packet" },
        };
      }
      const attr = attributionFrom(ops);
      const { data, error } = await sb.from("split_sheet_deliveries").update({
        delivery_result: "sent",
        response_notes: evidence,
        delivered_by: attr.actor_kind,
        delivered_by_label: attr.actor_label,
      }).eq("id", deliveryId).select("*").single();
      if (error) return { status: 500, data: { error: error.message } };
      await sb.from("rights_document_audit_events").insert({
        track_id: row.track_id,
        split_sheet_id: row.split_sheet_id,
        event_kind: "manual_submission",
        actor_kind: attr.actor_kind,
        actor_label: attr.actor_label,
        actor_user_id: attr.actor_user_id,
        document_hash: row.document_hash,
        detail: { delivery_id: deliveryId, evidence },
      });
      return { status: 200, data: { ok: true, delivery: data, sent: true } };
    }

    case "list_split_sheet_deliveries": {
      if (!canDeliver(ops) && ops.kind !== "human_admin") {
        return { status: 403, data: { error: `${ops.label} may not list deliveries` } };
      }
      const trackId = String(clean.track_id ?? "").trim();
      let q = sb
        .from("split_sheet_deliveries")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(clean.limit) || 50, 200));
      if (trackId) q = q.eq("track_id", trackId);
      if (clean.split_sheet_id) q = q.eq("split_sheet_id", String(clean.split_sheet_id));
      const { data, error } = await q;
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, rows: data ?? [] } };
    }

    case "record_split_sheet_delivery_response": {
      if (!canDeliver(ops) && ops.kind !== "human_admin") {
        return { status: 403, data: { error: `${ops.label} may not record delivery responses` } };
      }
      const deliveryId = String(clean.delivery_id ?? clean.id ?? "").trim();
      if (!deliveryId) return { status: 400, data: { error: "delivery_id required" } };
      const { data, error } = await sb
        .from("split_sheet_deliveries")
        .update({
          response_notes: clean.response_notes != null ? String(clean.response_notes) : null,
          follow_up_required: clean.follow_up_required === true,
          delivery_result: clean.delivery_result != null
            ? String(clean.delivery_result)
            : undefined,
        })
        .eq("id", deliveryId)
        .select("*")
        .single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, delivery: data } };
    }

    default:
      return {
        status: 400,
        data: { error: `Unknown split-sheet delivery action: ${action}` },
      };
  }
}
