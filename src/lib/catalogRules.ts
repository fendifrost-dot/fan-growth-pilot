/**
 * Stable catalog track IDs and lane rules.
 * Primary control is UUID — never display-title matching.
 */

export const TRACK_IDS = {
  MEDITATE: "506ad12f-9e2e-450c-b2e9-f3d10670c015",
  BALENCIAGA: "2e1874d8-efd4-4656-8cce-2ab0d111ddd3",
  ELECTRILLA: "36ece74b-3518-4676-b9f2-367c82f93117",
  CONTROL: "5d09da7e-98cf-4276-8dca-861d1fbbfa98",
  NEVA_TOO_MUCH_PRADA: "dc36a2c5-f07e-40da-a1b4-0c46c67fadd8",
} as const;

/** Only these three tracks may use the House/electronic lane. */
export const HOUSE_ELECTRONIC_TRACK_IDS: ReadonlySet<string> = new Set([
  TRACK_IDS.BALENCIAGA,
  TRACK_IDS.ELECTRILLA,
  TRACK_IDS.CONTROL,
]);

export function normalizeTrackId(id: string | null | undefined): string {
  return String(id ?? "").trim().toLowerCase();
}

export function isHouseElectronicTrackId(trackId: string | null | undefined): boolean {
  return HOUSE_ELECTRONIC_TRACK_IDS.has(normalizeTrackId(trackId));
}

export function isMeditateTrackId(trackId: string | null | undefined): boolean {
  return normalizeTrackId(trackId) === TRACK_IDS.MEDITATE;
}

/**
 * Write-boundary gate for genre_stamp = house_electronic.
 * Requires exact track_id. Title is never the primary control.
 */
export function assertHouseElectronicStampAllowed(
  trackId: string | null | undefined,
  genreStamp: string,
): { ok: true } | { ok: false; error: string } {
  if (genreStamp !== "house_electronic") return { ok: true };
  const id = normalizeTrackId(trackId);
  if (!id) {
    return {
      ok: false,
      error: "house_electronic stamp requires exact track_id (stable UUID). Title matching is not allowed.",
    };
  }
  if (isMeditateTrackId(id)) {
    return {
      ok: false,
      error: "MEDITATE (Hip-Hop/Rap) cannot be stamped house_electronic.",
    };
  }
  if (!isHouseElectronicTrackId(id)) {
    return {
      ok: false,
      error:
        "house_electronic is allow-listed to Balenciaga, Electrilla, and Designed For Me (Control) track IDs only.",
    };
  }
  return { ok: true };
}

/**
 * Sync readiness is NEVER inferred from has_sample alone.
 * has_sample === "no" does not make a track sync-ready.
 */
export type SyncGateInput = {
  hasSample?: string | null;
  approvedDnaVersionId?: string | null;
  sampleDeclarationApproved?: boolean;
  syncApprovedByFendi?: boolean;
  splitsReady?: boolean;
  publishingReady?: boolean;
  assetsReady?: boolean;
  unresolvedRightsException?: boolean;
  /** Explicit exception workflow resolved sample=yes/unknown for sync. */
  sampleExceptionResolved?: boolean;
  /** Neva Too Much Prada stays sync-blocked until private license evidence exists. */
  privateLicenseRequired?: boolean;
  privateLicenseOnFile?: boolean;
};

export function evaluateSyncReady(input: SyncGateInput): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.approvedDnaVersionId) blockers.push("approved_song_dna");
  if (!input.sampleDeclarationApproved) blockers.push("fendi_sample_declaration_approval");
  if (!input.syncApprovedByFendi) blockers.push("fendi_sync_approval");
  if (!input.splitsReady) blockers.push("splits_status");
  if (!input.publishingReady) blockers.push("publishing_ownership_status");
  if (!input.assetsReady) blockers.push("required_audio_assets");
  if (input.unresolvedRightsException) blockers.push("unresolved_rights_exception");

  const sample = String(input.hasSample ?? "unknown");
  if (sample === "yes" || sample === "unknown") {
    if (!input.sampleExceptionResolved) blockers.push("sample_rights_exception");
  }

  if (input.privateLicenseRequired && !input.privateLicenseOnFile) {
    blockers.push("private_license_evidence");
  }

  return { ready: blockers.length === 0, blockers };
}

/** @deprecated Do not use for eligibility. Always false — sample alone never grants sync. */
export function computeSyncEligible(_hasSample?: string | null): boolean {
  return false;
}
