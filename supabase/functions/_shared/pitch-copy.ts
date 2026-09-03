/**
 * Resolve song pitch copy from the database — never from source literals.
 *
 * Precedence (track first: the copy describes the song):
 *   1. tracks.short_pitch
 *   2. tracks.pitch_angle
 *   3. playlist_targets.recommended_pitch_angle
 *   4. artist_config.lanes[lane].pitch_angle
 *   5. missing → caller must 422 (do not invent genre copy)
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { loadLanesConfig, type LaneConfig } from "./playlist-lanes.ts";

export const PITCH_COPY_MISSING_FIELDS = [
  "tracks.short_pitch",
  "tracks.pitch_angle",
  "playlist_targets.recommended_pitch_angle",
] as const;

export type PitchCopySource =
  | "tracks.short_pitch"
  | "tracks.pitch_angle"
  | "playlist_targets.recommended_pitch_angle"
  | "artist_config.lanes.pitch_angle";

export type PitchCopyOk = {
  ok: true;
  pitch: string;
  source: PitchCopySource;
};

export type PitchCopyMissing = {
  ok: false;
  pitch: null;
  source: null;
  missing: string[];
};

export type PitchCopyResult = PitchCopyOk | PitchCopyMissing;

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sync resolution when the caller already has the track row, playlist row, and
 * lanes map. `sb` is accepted so every call site shares one signature; it is
 * unused when `lanes` is provided.
 */
export function resolvePitchAngle(
  _sb: SupabaseClient | null,
  args: {
    track?: {
      short_pitch?: unknown;
      pitch_angle?: unknown;
    } | null;
    row?: {
      recommended_pitch_angle?: unknown;
      lane?: unknown;
    } | null;
    lanes?: Record<string, LaneConfig>;
  },
): PitchCopyResult {
  const missing: string[] = [...PITCH_COPY_MISSING_FIELDS];
  const shortPitch = trimText(args.track?.short_pitch);
  if (shortPitch) return { ok: true, pitch: shortPitch, source: "tracks.short_pitch" };

  const trackAngle = trimText(args.track?.pitch_angle);
  if (trackAngle) return { ok: true, pitch: trackAngle, source: "tracks.pitch_angle" };

  const recommended = trimText(args.row?.recommended_pitch_angle);
  if (recommended) {
    return { ok: true, pitch: recommended, source: "playlist_targets.recommended_pitch_angle" };
  }

  const lane = trimText(args.row?.lane);
  const laneAngle = lane ? trimText(args.lanes?.[lane]?.pitch_angle) : "";
  if (laneAngle) return { ok: true, pitch: laneAngle, source: "artist_config.lanes.pitch_angle" };

  if (lane) missing.push("artist_config.lanes.pitch_angle");
  return { ok: false, pitch: null, source: null, missing };
}

/** Async wrapper: loads lanes from artist_config when the caller did not pass them. */
export async function resolvePitchAngleAsync(
  sb: SupabaseClient,
  args: {
    track?: { short_pitch?: unknown; pitch_angle?: unknown } | null;
    row?: { recommended_pitch_angle?: unknown; lane?: unknown } | null;
    lanes?: Record<string, LaneConfig>;
  },
): Promise<PitchCopyResult> {
  const lanes = args.lanes ?? await loadLanesConfig(sb);
  return resolvePitchAngle(sb, { ...args, lanes });
}

export function missingPitchCopyResult(args: {
  trackName: string;
  trackId: string | null;
  playlistId: string;
  lane: string | null;
}): { status: 422; data: Record<string, unknown> } {
  return {
    status: 422,
    data: {
      error: "No pitch copy configured",
      track_name: args.trackName,
      track_id: args.trackId,
      playlist_id: args.playlistId,
      lane: args.lane,
      missing: [...PITCH_COPY_MISSING_FIELDS],
      remedy: "Set a short pitch for this track in Admin → Songs.",
    },
  };
}

/** Case-insensitive exact match for PostgREST `ilike` (no wildcards). */
export function escapeIlikeExact(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
