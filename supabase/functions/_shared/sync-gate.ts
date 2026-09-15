/**
 * Fendi-only sync gate approvals + ops flag updates.
 * Recomputes tracks.sync_eligible server-side after mutations.
 *
 * Playlist outreach eligibility / DNA lanes are a different field set.
 * These actions never write tracks.outreach_eligibility or eligibility_*.
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
  recomputeAndPersistSyncEligibility,
} from "./sync-eligibility.ts";
import { rejectCallerSyncIdentity } from "./sync-research-config.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const SYNC_GATE_ACTIONS = [
  "get_sync_eligibility",
  "approve_sample_declaration",
  "approve_sync_eligibility",
  "recompute_sync_eligibility",
  "update_sync_gate_ops_flags",
] as const;

export const SAMPLE_DECLARATION_VALUES = ["yes", "no", "unknown"] as const;
export type SampleDeclarationValue = (typeof SAMPLE_DECLARATION_VALUES)[number];

export const SYNC_ELIGIBILITY_DECISIONS = ["yes", "no"] as const;
export type SyncEligibilityDecisionValue = (typeof SYNC_ELIGIBILITY_DECISIONS)[number];

/** Fendi-supplied sample flag. Distinct from rejected caller `has_sample`. */
export function parseSampleDeclarationInput(v: unknown): SampleDeclarationValue | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  return (SAMPLE_DECLARATION_VALUES as readonly string[]).includes(s)
    ? (s as SampleDeclarationValue)
    : "invalid";
}

/** YES records Fendi sync approval; NO clears it. Eligibility stays server-computed. */
export function parseSyncEligibilityDecision(v: unknown): SyncEligibilityDecisionValue | "invalid" {
  if (v === undefined || v === null || v === "") return "yes";
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "approve" || s === "approved") return "yes";
  if (s === "false" || s === "revoke" || s === "deny" || s === "denied") return "no";
  return (SYNC_ELIGIBILITY_DECISIONS as readonly string[]).includes(s)
    ? (s as SyncEligibilityDecisionValue)
    : "invalid";
}

/** DNA recommendation vs computed tracks.sync_eligible — surface both; never overwrite DNA. */
export function dnaConflictsWithComputedEligibility(
  dnaRecommendation: string | null | undefined,
  computedEligible: boolean,
): boolean {
  const rec = String(dnaRecommendation ?? "").trim().toLowerCase();
  if (!rec) return false;
  if (computedEligible && rec !== "approved") return true;
  if (!computedEligible && rec === "approved") return true;
  return false;
}

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
  const declared = parseSampleDeclarationInput(clean.sample_declaration);
  if (declared === "invalid") {
    return { status: 400, data: { error: "sample_declaration must be yes|no|unknown" } };
  }
  const patch: Record<string, unknown> = {
    sample_declaration_approved_at: now,
    sample_declaration_approved_by: attr.actor_label,
    updated_at: now,
  };
  // Fendi-authenticated declaration writes tracks.has_sample. Caller `has_sample` stays rejected.
  if (declared) patch.has_sample = declared;
  if (typeof clean.sample_exception_resolved === "boolean") {
    patch.sample_exception_resolved = clean.sample_exception_resolved;
  }
  const { data, error } = await sb
    .from("tracks")
    .update(patch)
    .eq("id", trackId)
    .select(
      "id, name, has_sample, sample_declaration_approved_at, sample_declaration_approved_by, sample_exception_resolved",
    )
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
      approved_by_user_id: attr.actor_user_id,
      note: "Sample declaration recorded on the track. Approved Song DNA sample_declaration is not overwritten.",
    },
  };
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

  const decisionInput = parseSyncEligibilityDecision(clean.decision);
  if (decisionInput === "invalid") {
    return { status: 400, data: { error: "decision must be yes|no" } };
  }

  const attr = attributionFrom(ops);
  const now = new Date().toISOString();
  const patch =
    decisionInput === "yes"
      ? {
          sync_approved_at: now,
          // Schema is text (actor label), not uuid — store the resolved ops label.
          sync_approved_by: attr.actor_label,
          updated_at: now,
        }
      : {
          sync_approved_at: null,
          sync_approved_by: null,
          updated_at: now,
        };
  const { data, error } = await sb
    .from("tracks")
    .update(patch)
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
      decision: decisionInput,
      track: data,
      eligibility: decision,
      approved_by_user_id: decisionInput === "yes" ? attr.actor_user_id : null,
      note:
        decisionInput === "yes"
          ? "Fendi sync approval recorded; tracks.sync_eligible stays server-computed and is true only when all gate blockers clear. Playlist approval is a separate field."
          : "Fendi sync approval cleared; tracks.sync_eligible recomputed. Playlist/outreach eligibility was not changed.",
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

export async function getSyncEligibility(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<RunResult> {
  const trackId = String(body.track_id ?? "").trim();
  if (!trackId) return { status: 400, data: { error: "track_id required" } };

  const { data: track, error: tErr } = await sb
    .from("tracks")
    .select(
      "id, name, has_sample, sync_eligible, sync_eligible_blockers, sync_eligible_computed_at, assets_ready, publishing_ready, splits_ready, splits_ready_source, current_split_sheet_id, unresolved_rights_exception, sample_exception_resolved, sample_declaration_approved_at, sample_declaration_approved_by, sync_approved_at, sync_approved_by, approved_song_dna_version_id, outreach_eligibility",
    )
    .eq("id", trackId)
    .maybeSingle();
  if (tErr) return { status: 500, data: { error: tErr.message } };
  if (!track) return { status: 404, data: { error: "track not found" } };

  let dna: Record<string, unknown> | null = null;
  const dnaId = track.approved_song_dna_version_id
    ? String(track.approved_song_dna_version_id)
    : null;
  if (dnaId) {
    const { data: dnaRow, error: dErr } = await sb
      .from("song_dna_versions")
      .select("id, version_number, approval_state, sample_declaration, sync_recommendation, approved_lanes")
      .eq("id", dnaId)
      .maybeSingle();
    if (dErr) return { status: 500, data: { error: dErr.message } };
    dna = (dnaRow as Record<string, unknown> | null) ?? null;
  }

  const eligibility = await computeTrackSyncEligibility(sb, trackId);
  if ("error" in eligibility) return { status: 500, data: { error: eligibility.error } };

  const dnaRec = dna ? String(dna.sync_recommendation ?? "") : "";
  return {
    status: 200,
    data: {
      ok: true,
      track,
      dna,
      eligibility,
      dna_sync_recommendation: dnaRec || null,
      track_sync_eligible: track.sync_eligible === true,
      computed_sync_eligible: eligibility.eligible,
      dna_conflicts_with_computed: dnaConflictsWithComputedEligibility(dnaRec, eligibility.eligible),
      playlist_vs_sync: {
        outreach_eligibility: track.outreach_eligibility ?? null,
        note: "Playlist/outreach eligibility and Song DNA approved_lanes do not grant sync eligibility.",
      },
    },
  };
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
    case "get_sync_eligibility":
      return getSyncEligibility(sb, body);
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
