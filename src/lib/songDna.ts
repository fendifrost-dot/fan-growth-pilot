/**
 * Client-side Song DNA labels and helpers (mirrors edge contracts).
 * Approvals are never invented client-side — CCA enforces admin JWT.
 */

export type SongDnaApprovalState =
  | "draft"
  | "pending_fendi_review"
  | "approved"
  | "rejected";

export type SongDnaVersion = {
  id: string;
  track_id: string;
  track_name?: string | null;
  version_number: number;
  approval_state: SongDnaApprovalState;
  primary_genre: string | null;
  secondary_genres: string[];
  approved_lanes: string[];
  excluded_lanes: string[];
  mood_tags: string[];
  context_tags?: string[];
  reference_artists?: string[];
  short_pitch?: string | null;
  bpm_hint: number | null;
  energy_hint: number | null;
  sample_declaration: "yes" | "no" | "unknown";
  sync_recommendation: "blocked" | "candidate" | "approved" | "rejected";
  notes: string | null;
  payload: Record<string, unknown>;
  created_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
};

export const DNA_STATE_LABEL: Record<SongDnaApprovalState, string> = {
  draft: "Draft",
  pending_fendi_review: "Pending Fendi review",
  approved: "Approved",
  rejected: "Rejected",
};

export function isEditableDnaState(state: SongDnaApprovalState): boolean {
  return state === "draft" || state === "rejected";
}

/** Parse comma/newline lane lists from form inputs. */
export function parseLaneList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sync readiness blockers — DNA id required; never invent approval. */
export function evaluateSyncReady(input: {
  approvedDnaVersionId?: string | null;
  sampleDeclarationApproved?: boolean;
  syncApprovedByFendi?: boolean;
}): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.approvedDnaVersionId) blockers.push("approved_song_dna");
  if (!input.sampleDeclarationApproved) blockers.push("fendi_sample_declaration_approval");
  if (!input.syncApprovedByFendi) blockers.push("fendi_sync_approval");
  return { ready: blockers.length === 0, blockers };
}
