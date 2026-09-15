/**
 * Client labels + helpers for the per-track sync eligibility panel.
 * Authoritative compute lives server-side (sync-eligibility / sync-gate).
 * Playlist outreach eligibility is a different field set — never treat it as sync.
 */

export const SYNC_ELIGIBILITY_BLOCKER_LABEL: Record<string, string> = {
  approved_song_dna: "Approved Song DNA required",
  fendi_sample_declaration_approval: "Fendi sample-declaration approval required",
  rights_review: "Unresolved rights exception",
  required_splits: "Authoritative finalized split sheet required",
  publishing_readiness: "Publishing readiness required",
  asset_readiness: "Asset readiness required",
  fendi_sync_approval: "Fendi sync approval required",
  private_license_evidence: "Verified private-license evidence required",
  sample_uncleared: "Sample declared yes without resolved exception or license",
};

export type SampleDeclarationValue = "yes" | "no" | "unknown";
export type SyncEligibilityDecisionValue = "yes" | "no";

export type SyncEligibilitySnapshot = {
  track_id: string;
  eligible: boolean;
  blockers: string[];
  reasons: string[];
  song_dna_version_id: string | null;
  computed_at: string;
};

export type SyncEligibilityDna = {
  id: string;
  version_number?: number | null;
  approval_state?: string | null;
  sample_declaration?: string | null;
  sync_recommendation?: string | null;
  approved_lanes?: string[] | null;
};

export type SyncEligibilityTrack = {
  id: string;
  name?: string | null;
  has_sample?: string | null;
  sync_eligible?: boolean | null;
  sync_eligible_blockers?: string[] | null;
  sync_eligible_computed_at?: string | null;
  assets_ready?: boolean | null;
  publishing_ready?: boolean | null;
  splits_ready?: boolean | null;
  splits_ready_source?: string | null;
  current_split_sheet_id?: string | null;
  unresolved_rights_exception?: boolean | null;
  sample_exception_resolved?: boolean | null;
  sample_declaration_approved_at?: string | null;
  sample_declaration_approved_by?: string | null;
  sync_approved_at?: string | null;
  sync_approved_by?: string | null;
  approved_song_dna_version_id?: string | null;
  outreach_eligibility?: string | null;
};

export type SyncEligibilityPayload = {
  ok?: boolean;
  track?: SyncEligibilityTrack;
  dna?: SyncEligibilityDna | null;
  eligibility?: SyncEligibilitySnapshot;
  dna_sync_recommendation?: string | null;
  track_sync_eligible?: boolean;
  computed_sync_eligible?: boolean;
  dna_conflicts_with_computed?: boolean;
  playlist_vs_sync?: {
    outreach_eligibility?: string | null;
    note?: string;
  };
};

export function blockerLabel(code: string): string {
  return SYNC_ELIGIBILITY_BLOCKER_LABEL[code] ?? code;
}

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

export function formatActorStamp(
  at: string | null | undefined,
  by: string | null | undefined,
): string | null {
  if (!at && !by) return null;
  const when = at ? new Date(at).toLocaleString() : "time not recorded";
  const who = by?.trim() || "unknown actor";
  return `${who} · ${when}`;
}
