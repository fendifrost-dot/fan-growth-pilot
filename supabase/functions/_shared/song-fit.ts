/**
 * Song ↔ playlist fit — ONE authoritative lane decision for discovery, verification,
 * Grok review, and sending (evaluateOutreachDecision uses decideLaneFit for its lane step).
 *
 * The unit of fit is the playlist LANE (e.g. rap_trap_hype) checked against the song's
 * current Fendi-approved Song DNA approved_lanes / excluded_lanes. The DNA primary_genre
 * (e.g. hip_hop_rap) is a broad genre FAMILY stamp, not a lane: "primary_genre is
 * hip_hop_rap" never means "only a lane literally named hip_hop_rap fits". Comparing the
 * broad genre with a narrower lane is the contradiction this module exists to prevent.
 *
 * Song-specific fit is preserved: each song's own approved/excluded lanes decide, and a
 * lane approved for one song grants nothing to another.
 */

export const SONG_FIT_POLICY_VERSION = "song_fit.v1-2026-09-28";

export type LaneFitCode =
  | "lane_approved"
  | "lane_excluded"
  | "lane_not_in_approved_dna"
  | "lane_missing"
  | "dna_unavailable"
  | "dna_has_no_approved_lanes";

export type LaneFitDecision = {
  fit: boolean;
  code: LaneFitCode;
  reason: string;
  lane: string | null;
  song_dna_version_id: string | null;
  primary_genre: string | null;
  approved_lanes: string[];
  excluded_lanes: string[];
  policy_version: string;
  basis: "lane_vs_approved_song_dna";
  primary_genre_note: string;
};

export type ApprovedDnaLanes = {
  id?: string | null;
  primary_genre?: string | null;
  approved_lanes?: string[] | null;
  excluded_lanes?: string[] | null;
};

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Pure lane-fit decision against the current approved Song DNA. */
export function decideLaneFit(dna: ApprovedDnaLanes | null | undefined, laneRaw: unknown): LaneFitDecision {
  const lane = norm(laneRaw) || null;
  const approved = (dna?.approved_lanes ?? []).map(norm).filter(Boolean);
  const excluded = (dna?.excluded_lanes ?? []).map(norm).filter(Boolean);
  const primary = dna?.primary_genre ? String(dna.primary_genre) : null;
  const base = {
    lane,
    song_dna_version_id: dna?.id ? String(dna.id) : null,
    primary_genre: primary,
    approved_lanes: approved,
    excluded_lanes: excluded,
    policy_version: SONG_FIT_POLICY_VERSION,
    basis: "lane_vs_approved_song_dna" as const,
    primary_genre_note: primary
      ? `primary_genre "${primary}" is the song's broad genre family; fit is decided by lane membership in approved_lanes, not by comparing the lane to primary_genre.`
      : "fit is decided by lane membership in approved_lanes.",
  };
  if (!dna) {
    return { ...base, fit: false, code: "dna_unavailable", reason: "No current approved Song DNA for this song." };
  }
  if (!lane) {
    return { ...base, fit: false, code: "lane_missing", reason: "Target lane is null — unclassified targets cannot be judged for fit." };
  }
  if (excluded.includes(lane)) {
    return { ...base, fit: false, code: "lane_excluded", reason: `Lane "${lane}" is on the approved Song DNA excluded_lanes list.` };
  }
  if (!approved.length) {
    // Same semantics as evaluateOutreachDecision: an empty approved set does not block.
    return { ...base, fit: true, code: "dna_has_no_approved_lanes", reason: "Approved Song DNA lists no approved_lanes; lane is not excluded." };
  }
  if (!approved.includes(lane)) {
    return { ...base, fit: false, code: "lane_not_in_approved_dna", reason: `Lane "${lane}" is not in the approved Song DNA approved_lanes set.` };
  }
  return { ...base, fit: true, code: "lane_approved", reason: `Lane "${lane}" is in the approved Song DNA approved_lanes set.` };
}

/**
 * Reviewer reason text / code that claims a DNA or lane (genre-fit) mismatch. Used to
 * stop a fit rejection that contradicts the authoritative decision above. Rejections for
 * other reasons (legitimacy, reach, language, route) are never blocked.
 */
const FIT_REASON_RE =
  /\b(dna[_\s-]*lane|lane[_\s-]*mismatch|dna[_\s-]*mismatch|genre[_\s-]*mismatch|lane[_\s-]*not[_\s-]*(approved|allowed)|hip[_\s-]*hop[_\s-]*rap\s+only|wrong[_\s-]*lane|off[_\s-]*lane)\b/i;

export function isFitRejectionReason(...parts: unknown[]): boolean {
  return parts.some((p) => typeof p === "string" && FIT_REASON_RE.test(p));
}

/**
 * Returns a conflict when a reviewer rejects for DNA/lane fit but the authoritative
 * decision says the lane fits the song's approved DNA. null = no conflict.
 */
export function fitRejectionConflict(
  decision: LaneFitDecision,
  reasonCode: unknown,
  reasonText: unknown,
): { code: "fit_decision_conflict"; message: string; decision: LaneFitDecision } | null {
  if (!isFitRejectionReason(reasonCode, reasonText)) return null;
  if (!decision.fit) return null;
  return {
    code: "fit_decision_conflict",
    message:
      `Rejection cites a DNA/lane mismatch, but lane "${decision.lane}" is approved by the song's current ` +
      `Song DNA (${decision.song_dna_version_id}; policy ${decision.policy_version}). ` +
      "Reject with a non-fit reason_code (e.g. playlist_quality, language_mismatch, low_reach, route_problem) " +
      "or ask Fendi to change the approved Song DNA.",
    decision,
  };
}
