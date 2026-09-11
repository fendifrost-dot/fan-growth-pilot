/**
 * Authoritative server-side sync eligibility gate.
 *
 * Never trusts caller-supplied has_sample, sync_eligible, DNA identity,
 * or model-inferred approval. Computes blockers from AGH rows only.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const SYNC_ELIGIBILITY_BLOCKERS = [
  "approved_song_dna",
  "fendi_sample_declaration_approval",
  "rights_review",
  "required_splits",
  "publishing_readiness",
  "asset_readiness",
  "fendi_sync_approval",
  "private_license_evidence",
  "sample_uncleared",
] as const;

export type SyncEligibilityBlocker = (typeof SYNC_ELIGIBILITY_BLOCKERS)[number];

export type SyncEligibilityDecision = {
  track_id: string;
  eligible: boolean;
  blockers: SyncEligibilityBlocker[];
  reasons: string[];
  song_dna_version_id: string | null;
  computed_at: string;
};

type TrackGateRow = {
  id: string;
  name?: string | null;
  approved_song_dna_version_id?: string | null;
  has_sample?: string | null;
  assets_ready?: boolean | null;
  publishing_ready?: boolean | null;
  splits_ready?: boolean | null;
  unresolved_rights_exception?: boolean | null;
  sample_exception_resolved?: boolean | null;
  sample_declaration_approved_at?: string | null;
  sample_declaration_approved_by?: string | null;
  sync_approved_at?: string | null;
  sync_approved_by?: string | null;
};

type DnaGateRow = {
  id: string;
  approval_state?: string | null;
  sample_declaration?: string | null;
  sync_recommendation?: string | null;
  payload?: Record<string, unknown> | null;
};

function truthy(v: unknown): boolean {
  return v === true;
}

/** Pure evaluation from already-loaded AGH rows. */
export function evaluateSyncEligibility(input: {
  track: TrackGateRow;
  dna: DnaGateRow | null;
  privateLicenseVerified: boolean;
}): SyncEligibilityDecision {
  const blockers: SyncEligibilityBlocker[] = [];
  const reasons: string[] = [];
  const trackId = String(input.track.id);
  const computedAt = new Date().toISOString();

  const dnaOk =
    input.dna != null &&
    String(input.dna.approval_state ?? "") === "approved" &&
    String(input.dna.id) === String(input.track.approved_song_dna_version_id ?? "");
  if (!dnaOk) {
    blockers.push("approved_song_dna");
    reasons.push("Current Fendi-approved Song DNA required");
  }

  if (!input.track.sample_declaration_approved_at || !input.track.sample_declaration_approved_by) {
    blockers.push("fendi_sample_declaration_approval");
    reasons.push("Fendi-approved sample declaration required");
  }

  const sampleDecl = String(
    input.dna?.sample_declaration ?? input.track.has_sample ?? "unknown",
  ).toLowerCase();
  if (sampleDecl === "yes") {
    if (!truthy(input.track.sample_exception_resolved) && !input.privateLicenseVerified) {
      blockers.push("sample_uncleared");
      reasons.push("Sample declared yes without resolved exception or verified private license");
    }
  } else if (sampleDecl !== "no") {
    blockers.push("fendi_sample_declaration_approval");
    reasons.push("Sample declaration must be cleared as no (or yes with exception/license)");
  }

  if (truthy(input.track.unresolved_rights_exception)) {
    blockers.push("rights_review");
    reasons.push("Unresolved rights exception blocks sync");
  }

  if (!truthy(input.track.splits_ready)) {
    blockers.push("required_splits");
    reasons.push("Required splits not marked ready");
  }
  if (!truthy(input.track.publishing_ready)) {
    blockers.push("publishing_readiness");
    reasons.push("Publishing readiness required");
  }
  if (!truthy(input.track.assets_ready)) {
    blockers.push("asset_readiness");
    reasons.push("Asset readiness required");
  }

  if (!input.track.sync_approved_at || !input.track.sync_approved_by) {
    blockers.push("fendi_sync_approval");
    reasons.push("Fendi sync approval required");
  }

  const payload = (input.dna?.payload ?? {}) as Record<string, unknown>;
  const requiresPrivate =
    payload.requires_private_license === true ||
    sampleDecl === "yes";
  if (requiresPrivate && !input.privateLicenseVerified) {
    if (!blockers.includes("private_license_evidence")) {
      blockers.push("private_license_evidence");
      reasons.push("Required private-license evidence missing or unverified");
    }
  }

  // DNA sync_recommendation must be approved when DNA present — never invent.
  if (dnaOk && String(input.dna?.sync_recommendation ?? "") !== "approved") {
    if (!blockers.includes("fendi_sync_approval")) {
      blockers.push("fendi_sync_approval");
      reasons.push("Approved Song DNA sync_recommendation must be approved");
    }
  }

  return {
    track_id: trackId,
    eligible: blockers.length === 0,
    blockers,
    reasons,
    song_dna_version_id: dnaOk && input.dna ? String(input.dna.id) : null,
    computed_at: computedAt,
  };
}

export async function loadPrivateLicenseVerified(
  sb: SupabaseClient,
  trackId: string,
): Promise<boolean> {
  const { data } = await sb
    .from("private_license_evidence")
    .select("id, verified_at")
    .eq("track_id", trackId)
    .not("verified_at", "is", null)
    .limit(1);
  return (data ?? []).length > 0;
}

/** Load track + current approved DNA + license evidence and evaluate. */
export async function computeTrackSyncEligibility(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncEligibilityDecision | { error: string }> {
  const { data: track, error: tErr } = await sb
    .from("tracks")
    .select(
      "id, name, approved_song_dna_version_id, has_sample, assets_ready, publishing_ready, splits_ready, unresolved_rights_exception, sample_exception_resolved, sample_declaration_approved_at, sample_declaration_approved_by, sync_approved_at, sync_approved_by",
    )
    .eq("id", trackId)
    .maybeSingle();
  if (tErr) return { error: tErr.message };
  if (!track) return { error: "track not found" };

  let dna: DnaGateRow | null = null;
  const dnaId = track.approved_song_dna_version_id
    ? String(track.approved_song_dna_version_id)
    : null;
  if (dnaId) {
    const { data: dnaRow, error: dErr } = await sb
      .from("song_dna_versions")
      .select("id, approval_state, sample_declaration, sync_recommendation, payload")
      .eq("id", dnaId)
      .maybeSingle();
    if (dErr) return { error: dErr.message };
    dna = dnaRow as DnaGateRow | null;
  }

  const licenseOk = await loadPrivateLicenseVerified(sb, trackId);
  return evaluateSyncEligibility({
    track: track as TrackGateRow,
    dna,
    privateLicenseVerified: licenseOk,
  });
}

/** Persist computed eligibility onto tracks. Caller must be authorized. */
export async function recomputeAndPersistSyncEligibility(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncEligibilityDecision | { error: string }> {
  const decision = await computeTrackSyncEligibility(sb, trackId);
  if ("error" in decision) return decision;
  const { error } = await sb
    .from("tracks")
    .update({
      sync_eligible: decision.eligible,
      sync_eligible_blockers: decision.blockers,
      sync_eligible_computed_at: decision.computed_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", trackId);
  if (error) return { error: error.message };
  return decision;
}

/** Ids currently marked sync_eligible after server compute — never caller input. */
export async function loadSyncEligibleTrackIds(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb.from("tracks").select("id").eq("sync_eligible", true);
  return (data ?? []).map((r) => String(r.id));
}

export function formatEligibilityBlock(decision: SyncEligibilityDecision): Record<string, unknown> {
  return {
    error: "sync_eligibility_blocked",
    code: "sync_eligibility_blocked",
    drafted: false,
    submitted: false,
    inferred_eligibility: false,
    track_id: decision.track_id,
    blockers: decision.blockers,
    reasons: decision.reasons,
    song_dna_version_id: decision.song_dna_version_id,
  };
}
