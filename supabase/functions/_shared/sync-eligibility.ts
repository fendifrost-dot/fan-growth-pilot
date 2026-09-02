/**
 * Persist tracks.sync_eligible from evaluateSyncReady — never from has_sample alone.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  TRACK_IDS,
  evaluateSyncReady,
  normalizeTrackId,
  type SyncGateInput,
} from "./catalog-rules.ts";

export type SyncRecomputeResult = {
  track_id: string;
  sync_eligible: boolean;
  blockers: string[];
  input: SyncGateInput;
};

function requiresPrivateLicense(trackId: string): boolean {
  return normalizeTrackId(trackId) === TRACK_IDS.NEVA_TOO_MUCH_PRADA;
}

export async function loadSyncGateInput(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncGateInput> {
  const { data: track, error } = await sb
    .from("tracks")
    .select(
      "id, has_sample, approved_song_dna_version_id, sample_declaration_approved_at, sync_approved_at, splits_ready, publishing_ready, assets_ready, unresolved_rights_exception, sample_exception_resolved",
    )
    .eq("id", trackId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!track) throw new Error("track not found");

  let approvedDnaVersionId = track.approved_song_dna_version_id
    ? String(track.approved_song_dna_version_id)
    : null;

  if (approvedDnaVersionId) {
    const { data: dna } = await sb
      .from("song_dna_versions")
      .select("id, approval_state, track_id")
      .eq("id", approvedDnaVersionId)
      .maybeSingle();
    if (!dna || String(dna.approval_state) !== "approved" || String(dna.track_id) !== trackId) {
      approvedDnaVersionId = null;
    }
  }
  if (!approvedDnaVersionId) {
    const { data: dna } = await sb
      .from("song_dna_versions")
      .select("id")
      .eq("track_id", trackId)
      .eq("approval_state", "approved")
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dna?.id) approvedDnaVersionId = String(dna.id);
  }

  let privateLicenseOnFile = false;
  const privateLicenseRequired = requiresPrivateLicense(trackId);
  if (privateLicenseRequired) {
    const { count } = await sb
      .from("private_license_evidence")
      .select("id", { count: "exact", head: true })
      .eq("track_id", trackId);
    privateLicenseOnFile = (count ?? 0) > 0;
  }

  return {
    hasSample: (track.has_sample as string | null) ?? "unknown",
    approvedDnaVersionId,
    sampleDeclarationApproved: Boolean(track.sample_declaration_approved_at),
    syncApprovedByFendi: Boolean(track.sync_approved_at),
    splitsReady: Boolean(track.splits_ready),
    publishingReady: Boolean(track.publishing_ready),
    assetsReady: Boolean(track.assets_ready),
    unresolvedRightsException: Boolean(track.unresolved_rights_exception),
    sampleExceptionResolved: Boolean(track.sample_exception_resolved),
    privateLicenseRequired,
    privateLicenseOnFile,
  };
}

export async function recomputeTrackSyncEligible(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncRecomputeResult> {
  const id = String(trackId ?? "").trim();
  if (!id) throw new Error("track_id required");

  const input = await loadSyncGateInput(sb, id);
  const { ready, blockers } = evaluateSyncReady(input);
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = {
    sync_eligible: ready,
    sync_eligible_blockers: blockers,
    sync_eligible_computed_at: now,
  };
  if (input.approvedDnaVersionId) {
    patch.approved_song_dna_version_id = input.approvedDnaVersionId;
  } else {
    patch.approved_song_dna_version_id = null;
  }

  const { error } = await sb.from("tracks").update(patch).eq("id", id);
  if (error) throw new Error(error.message);

  return {
    track_id: id,
    sync_eligible: ready,
    blockers,
    input,
  };
}
