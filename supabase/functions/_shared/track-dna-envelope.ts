/**
 * Server-side Song DNA envelope bound to a track — never trust caller DNA UUIDs
 * or playlist_targets.song_dna_version_id as authoritative.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { evaluateOutreachDecision, type OutreachDecision } from "./outreach-decision.ts";
import type { OpsActor } from "./ops-actors.ts";

export type TrackDnaResolution = {
  ok: boolean;
  trackId: string | null;
  songDnaVersionId: string | null;
  approvedLanes: string[];
  excludedLanes: string[];
  errors: string[];
  decision: OutreachDecision | null;
};

function trim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Resolve tracks.approved_song_dna_version_id server-side.
 * Reject caller-supplied song_dna_version_id when it does not equal the current
 * approved version, or when that version belongs to another track.
 */
export async function resolveCurrentApprovedDna(
  sb: SupabaseClient,
  opts: {
    trackId: string;
    callerSongDnaVersionId?: string | null;
  },
): Promise<{
  ok: boolean;
  songDnaVersionId: string | null;
  approvedLanes: string[];
  excludedLanes: string[];
  errors: string[];
}> {
  const trackId = trim(opts.trackId);
  const errors: string[] = [];
  if (!trackId) {
    return {
      ok: false,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: ["missing_track_id"],
    };
  }

  const { data: track, error: tErr } = await sb
    .from("tracks")
    .select("id, approved_song_dna_version_id")
    .eq("id", trackId)
    .maybeSingle();
  if (tErr) {
    return {
      ok: false,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: [`track_lookup_failed:${tErr.message}`],
    };
  }
  if (!track) {
    return {
      ok: false,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: ["track_id_not_found"],
    };
  }

  const currentId = trim(track.approved_song_dna_version_id);
  if (!currentId) {
    return {
      ok: false,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: ["missing_approved_song_dna"],
    };
  }

  const caller = trim(opts.callerSongDnaVersionId);
  if (caller && caller !== currentId) {
    errors.push("song_dna_not_current");
  }

  const { data: dna, error: dErr } = await sb
    .from("song_dna_versions")
    .select("id, track_id, approval_state, approved_lanes, excluded_lanes")
    .eq("id", currentId)
    .maybeSingle();
  if (dErr) {
    return {
      ok: false,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: [`dna_lookup_failed:${dErr.message}`],
    };
  }
  if (!dna) {
    errors.push("song_dna_not_found");
  } else if (String(dna.track_id) !== trackId) {
    // Approved DNA UUID belonging to another track must fail.
    errors.push("song_dna_track_mismatch");
  } else if (String(dna.approval_state) !== "approved") {
    errors.push("song_dna_not_approved");
  }

  if (errors.length || !dna) {
    return {
      ok: false,
      songDnaVersionId: currentId,
      approvedLanes: [],
      excludedLanes: [],
      errors: [...new Set(errors)],
    };
  }

  return {
    ok: true,
    songDnaVersionId: String(dna.id),
    approvedLanes: (dna.approved_lanes ?? []).map(String),
    excludedLanes: (dna.excluded_lanes ?? []).map(String),
    errors: [],
  };
}

/**
 * Full song-bound DNA + lane envelope for a playlist target.
 * Uses the canonical evaluateOutreachDecision choke point.
 */
export async function enforceTrackDnaLaneEnvelope(
  sb: SupabaseClient,
  opts: {
    route: string;
    trackId: string;
    playlistId: string;
    callerSongDnaVersionId?: string | null;
    actor?: OpsActor | null;
  },
): Promise<TrackDnaResolution> {
  const trackId = trim(opts.trackId);
  const playlistId = trim(opts.playlistId);
  if (!trackId || !playlistId) {
    return {
      ok: false,
      trackId: trackId || null,
      songDnaVersionId: null,
      approvedLanes: [],
      excludedLanes: [],
      errors: [
        !trackId ? "missing_track_id" : "",
        !playlistId ? "missing_playlist_id" : "",
      ].filter(Boolean),
      decision: null,
    };
  }

  // Pre-check caller DNA vs current pointer (also covered inside evaluateOutreachDecision).
  const resolved = await resolveCurrentApprovedDna(sb, {
    trackId,
    callerSongDnaVersionId: opts.callerSongDnaVersionId,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      trackId,
      songDnaVersionId: resolved.songDnaVersionId,
      approvedLanes: resolved.approvedLanes,
      excludedLanes: resolved.excludedLanes,
      errors: resolved.errors,
      decision: null,
    };
  }

  const decision = await evaluateOutreachDecision(sb, {
    route: opts.route,
    trackId,
    playlistId,
    // Always pass the server-resolved current approved id — never a foreign UUID.
    songDnaVersionId: resolved.songDnaVersionId,
    actor: opts.actor ?? null,
  });

  return {
    ok: decision.allow,
    trackId: decision.trackId,
    songDnaVersionId: decision.songDnaVersionId,
    approvedLanes: resolved.approvedLanes,
    excludedLanes: resolved.excludedLanes,
    errors: decision.errors,
    decision,
  };
}
