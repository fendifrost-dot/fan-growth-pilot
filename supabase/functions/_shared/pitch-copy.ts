/**
 * Resolve song pitch copy from the track / approved Song DNA only.
 *
 * {{pitch}} MUST NEVER be filled from playlist_targets.recommended_pitch_angle
 * or artist_config.lanes[lane].pitch_angle — those are target-fit copy only
 * (see resolveFitReason → {{fit_reason}}).
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const TRACK_PITCH_MISSING_FIELDS = [
  "tracks.short_pitch",
  "song_dna_versions.short_pitch (approved)",
] as const;

export type TrackPitchSource =
  | "song_dna_versions.short_pitch"
  | "tracks.short_pitch";

export type TrackPitchOk = {
  ok: true;
  pitch: string;
  source: TrackPitchSource;
  songDnaVersionId: string | null;
};

export type TrackPitchMissing = {
  ok: false;
  pitch: null;
  source: null;
  songDnaVersionId: null;
  missing: string[];
};

export type TrackPitchResult = TrackPitchOk | TrackPitchMissing;

export type FitReasonOk = {
  ok: true;
  fitReason: string;
  source: "playlist_targets.recommended_pitch_angle" | "artist_config.lanes.pitch_angle";
};

export type FitReasonEmpty = {
  ok: true;
  fitReason: "";
  source: null;
};

export type FitReasonResult = FitReasonOk | FitReasonEmpty;

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Song description for {{pitch}}. Track / approved DNA only.
 * Does not read playlist or lane pitch fields.
 */
export function resolveTrackPitchCopy(args: {
  track?: {
    id?: unknown;
    short_pitch?: unknown;
    pitch_angle?: unknown;
  } | null;
  approvedDna?: {
    id?: unknown;
    short_pitch?: unknown;
    approval_state?: unknown;
  } | null;
}): TrackPitchResult {
  const missing: string[] = [...TRACK_PITCH_MISSING_FIELDS];

  const dnaState = trimText(args.approvedDna?.approval_state);
  const dnaPitch = trimText(args.approvedDna?.short_pitch);
  if (dnaState === "approved" && dnaPitch) {
    return {
      ok: true,
      pitch: dnaPitch,
      source: "song_dna_versions.short_pitch",
      songDnaVersionId: trimText(args.approvedDna?.id) || null,
    };
  }

  // tracks.short_pitch is the operator-editable song description.
  // tracks.pitch_angle is treated as a legacy alias for the same song-level field
  // (not lane/playlist copy) until fully migrated into Song DNA.
  const shortPitch = trimText(args.track?.short_pitch);
  if (shortPitch) {
    return {
      ok: true,
      pitch: shortPitch,
      source: "tracks.short_pitch",
      songDnaVersionId: null,
    };
  }

  const legacyTrackAngle = trimText(args.track?.pitch_angle);
  if (legacyTrackAngle) {
    return {
      ok: true,
      pitch: legacyTrackAngle,
      source: "tracks.short_pitch",
      songDnaVersionId: null,
    };
  }

  return {
    ok: false,
    pitch: null,
    source: null,
    songDnaVersionId: null,
    missing,
  };
}

/** Target-fit explanation for {{fit_reason}} — never used as {{pitch}}. */
export function resolveFitReason(args: {
  row?: {
    recommended_pitch_angle?: unknown;
    lane?: unknown;
  } | null;
  lanes?: Record<string, { pitch_angle?: string | null }>;
}): FitReasonResult {
  const recommended = trimText(args.row?.recommended_pitch_angle);
  if (recommended) {
    return {
      ok: true,
      fitReason: recommended,
      source: "playlist_targets.recommended_pitch_angle",
    };
  }
  const lane = trimText(args.row?.lane);
  const laneAngle = lane ? trimText(args.lanes?.[lane]?.pitch_angle) : "";
  if (laneAngle) {
    return {
      ok: true,
      fitReason: laneAngle,
      source: "artist_config.lanes.pitch_angle",
    };
  }
  return { ok: true, fitReason: "", source: null };
}

/** @deprecated Use resolveTrackPitchCopy — kept name for call-site migration. */
export function resolvePitchAngle(
  _sb: SupabaseClient | null,
  args: {
    track?: {
      id?: unknown;
      short_pitch?: unknown;
      pitch_angle?: unknown;
    } | null;
    row?: {
      recommended_pitch_angle?: unknown;
      lane?: unknown;
    } | null;
    lanes?: Record<string, { pitch_angle?: string | null }>;
    approvedDna?: {
      id?: unknown;
      short_pitch?: unknown;
      approval_state?: unknown;
    } | null;
  },
): TrackPitchResult {
  // Intentionally ignores row/lanes for {{pitch}}.
  void args.row;
  void args.lanes;
  return resolveTrackPitchCopy({
    track: args.track,
    approvedDna: args.approvedDna,
  });
}

export async function resolvePitchAngleAsync(
  sb: SupabaseClient,
  args: {
    track?: {
      id?: unknown;
      short_pitch?: unknown;
      pitch_angle?: unknown;
    } | null;
    row?: {
      recommended_pitch_angle?: unknown;
      lane?: unknown;
    } | null;
    lanes?: Record<string, { pitch_angle?: string | null }>;
    approvedDna?: {
      id?: unknown;
      short_pitch?: unknown;
      approval_state?: unknown;
    } | null;
  },
): Promise<TrackPitchResult> {
  let approvedDna = args.approvedDna ?? null;
  const trackId = trimText(args.track?.id);
  if (!approvedDna && trackId) {
    const { data } = await sb
      .from("song_dna_versions")
      .select("id, short_pitch, approval_state")
      .eq("track_id", trackId)
      .eq("approval_state", "approved")
      .maybeSingle();
    if (data) approvedDna = data;
  }
  return resolveTrackPitchCopy({ track: args.track, approvedDna });
}

export function missingPitchCopyResult(args: {
  trackName: string;
  trackId: string | null;
  playlistId: string;
  lane: string | null;
  missing?: string[];
}): { status: 422; data: Record<string, unknown> } {
  return {
    status: 422,
    data: {
      error: "No pitch copy configured",
      track_name: args.trackName,
      track_id: args.trackId,
      playlist_id: args.playlistId,
      lane: args.lane,
      missing: args.missing ?? [...TRACK_PITCH_MISSING_FIELDS],
      remedy:
        "Set an approved song-specific short_pitch on this track (Admin → Songs / Song DNA). " +
        "Playlist or lane copy cannot populate {{pitch}}.",
    },
  };
}

export function escapeIlikeExact(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
