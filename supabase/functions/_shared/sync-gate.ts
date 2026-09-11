/**
 * Fendi-only sync gate approvals + ops flag updates.
 * Recomputes tracks.sync_eligible server-side after mutations.
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
import { recomputeAndPersistSyncEligibility } from "./sync-eligibility.ts";
import { rejectCallerSyncIdentity } from "./sync-research-config.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const SYNC_GATE_ACTIONS = [
  "approve_sample_declaration",
  "approve_sync_eligibility",
  "recompute_sync_eligibility",
  "update_sync_gate_ops_flags",
] as const;

export function isSyncGateAction(action: string): boolean {
  return (SYNC_GATE_ACTIONS as readonly string[]).includes(action);
}

async function requireFendiCap(
  ops: OpsActor,
  cap: Parameters<typeof can>[1],
): Promise<RunResult | null> {
  if (!can(ops, cap)) {
    return { status: 403, data: { error: `${ops.label} is not permitted to ${cap}` } };
  }
  return null;
}

export async function approveSampleDeclaration(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireFendiCap(ops, "approve_sample_declaration");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    sample_declaration_approved_at: now,
    sample_declaration_approved_by: attr.actor_label,
    updated_at: now,
  };
  if (typeof clean.sample_exception_resolved === "boolean") {
    patch.sample_exception_resolved = clean.sample_exception_resolved;
  }
  // Never accept caller has_sample as authority — optional note only when Fendi sets track flag via catalogue.
  const { data, error } = await sb
    .from("tracks")
    .update(patch)
    .eq("id", trackId)
    .select("id, name, sample_declaration_approved_at, sample_declaration_approved_by")
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  const decision = await recomputeAndPersistSyncEligibility(sb, trackId);
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  return { status: 200, data: { ok: true, track: data, eligibility: decision } };
}

export async function approveSyncEligibility(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireFendiCap(ops, "approve_sync_eligibility");
  if (denied) return denied;
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("tracks")
    .update({
      sync_approved_at: now,
      sync_approved_by: attr.actor_label,
      updated_at: now,
    })
    .eq("id", trackId)
    .select("id, name, sync_approved_at, sync_approved_by")
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  const decision = await recomputeAndPersistSyncEligibility(sb, trackId);
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  return {
    status: 200,
    data: {
      ok: true,
      track: data,
      eligibility: decision,
      note: "Fendi sync approval recorded; eligible only when all gate blockers clear",
    },
  };
}

export async function recomputeSyncEligibility(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  // Fendi or human_admin with update_sync_gate_ops_flags / approve_sync_eligibility.
  if (!can(ops, "approve_sync_eligibility") && !can(ops, "update_sync_gate_ops_flags")) {
    return {
      status: 403,
      data: { error: `${ops.label} is not permitted to recompute_sync_eligibility` },
    };
  }
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };
  const decision = await recomputeAndPersistSyncEligibility(sb, trackId);
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  return { status: 200, data: { ok: true, eligibility: decision } };
}

export async function updateSyncGateOpsFlags(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const denied = await requireFendiCap(ops, "update_sync_gate_ops_flags");
  if (denied) return denied;
  // Grok may update ops flags (assets/splits/publishing) but never Fendi approvals.
  const spoof = rejectCallerSyncIdentity(body);
  if (spoof) return { status: 400, data: { error: spoof, code: "caller_identity_rejected" } };
  const clean = stripSpoofedAttribution(body);
  const trackId = String(clean.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  // Explicitly reject Fendi-only fields from non-Fendi even if they somehow pass can().
  if (ops.kind !== "fendi") {
    for (const k of [
      "sync_approved_at",
      "sync_approved_by",
      "sample_declaration_approved_at",
      "sample_declaration_approved_by",
      "sync_eligible",
    ]) {
      if (Object.prototype.hasOwnProperty.call(clean, k)) {
        return {
          status: 403,
          data: { error: `${k} is Fendi-only`, code: "fendi_only_field" },
        };
      }
    }
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of [
    "assets_ready",
    "splits_ready",
    "publishing_ready",
    "unresolved_rights_exception",
    "sample_exception_resolved",
  ] as const) {
    if (typeof clean[key] === "boolean") patch[key] = clean[key];
  }
  if (Object.keys(patch).length <= 1) {
    return { status: 400, data: { error: "no ops flags to update" } };
  }

  const { data, error } = await sb
    .from("tracks")
    .update(patch)
    .eq("id", trackId)
    .select(
      "id, name, assets_ready, splits_ready, publishing_ready, unresolved_rights_exception, sample_exception_resolved",
    )
    .single();
  if (error) return { status: 500, data: { error: error.message } };

  const decision = await recomputeAndPersistSyncEligibility(sb, trackId);
  if ("error" in decision) return { status: 500, data: { error: decision.error } };
  return { status: 200, data: { ok: true, track: data, eligibility: decision } };
}

export async function runSyncGateAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case "approve_sample_declaration":
      return approveSampleDeclaration(sb, body, ops);
    case "approve_sync_eligibility":
      return approveSyncEligibility(sb, body, ops);
    case "recompute_sync_eligibility":
      return recomputeSyncEligibility(sb, body, ops);
    case "update_sync_gate_ops_flags":
      return updateSyncGateOpsFlags(sb, body, ops);
    default:
      return { status: 400, data: { error: `Unknown sync gate action: ${action}` } };
  }
}
