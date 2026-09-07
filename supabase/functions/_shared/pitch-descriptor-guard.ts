/**
 * Forbidden / excluded descriptor protection for playlist outreach copy.
 * Same family detectors used for lane genre classification — if DNA excludes
 * house (or primary genre is rap), composed copy must not contain house language.
 * Production code must never hard-code song titles.
 */
import { sweepLaneTextGenre } from "./playlist-lanes.ts";

export type DnaDescriptorContext = {
  primary_genre?: string | null;
  approved_lanes?: string[] | null;
  excluded_lanes?: string[] | null;
};

function laneLooksHouse(lane: string): boolean {
  const l = lane.toLowerCase();
  return l.includes("house") || l.includes("techno") || l.includes("edm") || l.includes("electronic");
}

function laneLooksRap(lane: string): boolean {
  const l = lane.toLowerCase();
  return l.includes("rap") || l.includes("hip_hop") || l.includes("trap") || l.includes("drill");
}

/**
 * Returns an error code when `copy` contains descriptors incompatible with DNA.
 * null = ok.
 */
export function assertCopyAgainstDnaDescriptors(
  copy: string,
  dna: DnaDescriptorContext,
): string | null {
  const text = (copy ?? "").trim();
  if (!text) return "missing_pitch_copy";

  const excluded = (dna.excluded_lanes ?? []).map((s) => String(s).toLowerCase());
  const approved = (dna.approved_lanes ?? []).map((s) => String(s).toLowerCase());
  const primary = String(dna.primary_genre ?? "").trim().toLowerCase();

  const houseExcluded =
    excluded.some(laneLooksHouse) ||
    primary === "rap" ||
    primary === "hip_hop" ||
    primary === "hip-hop" ||
    primary.includes("rap") ||
    (approved.length > 0 && approved.every(laneLooksRap) && !approved.some(laneLooksHouse));

  const rapExcluded =
    excluded.some(laneLooksRap) ||
    primary === "house" ||
    primary === "electronic" ||
    (approved.length > 0 && approved.every(laneLooksHouse) && !approved.some(laneLooksRap));

  const copyGenre = sweepLaneTextGenre(text);

  // Rap DNA / house-excluded: house/deep-house language must fail.
  if (houseExcluded && copyGenre === "house") {
    return "copy_contains_excluded_house_descriptor";
  }
  // House DNA / rap-excluded: hard rap genre claims must fail (symmetric).
  if (rapExcluded && copyGenre === "rap") {
    return "copy_contains_excluded_rap_descriptor";
  }
  return null;
}

/** Caller-written playlist copy fields that automated channels must hard-reject. */
export const CALLER_PLAYLIST_COPY_FIELDS = [
  { key: "draft_body", code: "caller_draft_body_rejected" },
  { key: "body", code: "caller_body_rejected" },
  { key: "subject", code: "caller_subject_rejected" },
  { key: "override_body", code: "override_body_rejected" },
  { key: "override_subject", code: "override_subject_rejected" },
  { key: "email_body", code: "caller_body_rejected" },
  { key: "pitch_body", code: "caller_body_rejected" },
  { key: "ig_dm_draft", code: "caller_draft_body_rejected" },
] as const;

export function rejectCallerPlaylistCopy(
  body: Record<string, unknown>,
): { status: 422; data: Record<string, unknown> } | null {
  for (const { key, code } of CALLER_PLAYLIST_COPY_FIELDS) {
    const raw = body[key];
    if (typeof raw === "string" && raw.trim()) {
      return {
        status: 422,
        data: {
          error:
            `${key} is rejected — compose playlist copy server-side from approved Song DNA only`,
          code,
          persisted: false,
        },
      };
    }
  }
  return null;
}
