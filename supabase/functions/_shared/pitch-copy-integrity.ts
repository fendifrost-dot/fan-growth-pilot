/**
 * Pitch-copy integrity helpers for draft provenance + send-time verification.
 *
 * The approved draft body is the artefact Grok approved. When the track's
 * resolved {{pitch}} changes after approval, send must refuse — never silently
 * re-render or release stale backlog copy.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolveTrackPitchCopy, type TrackPitchResult } from "./pitch-copy.ts";

export function normalizePitchCopy(pitch: string): string {
  return pitch.trim().replace(/\s+/g, " ");
}

/** SHA-256 hex of the normalized pitch string (Web Crypto — works in Deno edge). */
export async function hashPitchCopy(pitch: string): Promise<string> {
  const data = new TextEncoder().encode(normalizePitchCopy(pitch));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type DraftPitchIntegrityOk = {
  ok: true;
  pitch: string;
  source: string;
  hash: string;
  songDnaVersionId: string | null;
};

export type DraftPitchIntegrityFail = {
  ok: false;
  code: string;
  message: string;
  draftId: string;
  expectedHash?: string | null;
  currentHash?: string | null;
};

/**
 * Re-resolve live pitch for the draft's track and verify the approved artefact
 * still matches. Legacy drafts without pitch_copy_hash must contain the current
 * pitch text in body (so correct DFM drafts can still send; stale Meditate
 * house-copy drafts refuse).
 */
export async function verifyDraftPitchIntegrity(
  sb: SupabaseClient,
  draft: {
    id?: unknown;
    track_id?: unknown;
    body?: unknown;
    pitch_copy_hash?: unknown;
    pitch_copy_source?: unknown;
    song_dna_version_id?: unknown;
  },
): Promise<DraftPitchIntegrityOk | DraftPitchIntegrityFail> {
  const draftId = String(draft.id ?? "").trim();
  const trackId = String(draft.track_id ?? "").trim();
  if (!trackId) {
    return {
      ok: false,
      code: "draft_missing_track_id",
      message: "Draft is missing track_id — repair identity and regenerate before send.",
      draftId,
    };
  }

  const { data: track } = await sb
    .from("tracks")
    .select("id, short_pitch, pitch_angle")
    .eq("id", trackId)
    .maybeSingle();
  if (!track) {
    return {
      ok: false,
      code: "track_id_not_found",
      message: `Draft track_id ${trackId} not found.`,
      draftId,
    };
  }

  let approvedDna: {
    id?: unknown;
    short_pitch?: unknown;
    approval_state?: unknown;
  } | null = null;
  const dnaId = String(draft.song_dna_version_id ?? "").trim();
  if (dnaId) {
    const { data } = await sb
      .from("song_dna_versions")
      .select("id, track_id, short_pitch, approval_state")
      .eq("id", dnaId)
      .maybeSingle();
    if (!data || String(data.track_id) !== trackId) {
      return {
        ok: false,
        code: "song_dna_track_mismatch",
        message:
          "Draft song_dna_version_id does not belong to this draft's track — regenerate the draft.",
        draftId,
      };
    }
    if (String(data.approval_state) !== "approved") {
      return {
        ok: false,
        code: "song_dna_not_approved",
        message: "Draft references a Song DNA version that is not approved.",
        draftId,
      };
    }
    approvedDna = data;
  } else {
    const { data } = await sb
      .from("song_dna_versions")
      .select("id, short_pitch, approval_state")
      .eq("track_id", trackId)
      .eq("approval_state", "approved")
      .maybeSingle();
    if (data) approvedDna = data;
  }

  const resolved: TrackPitchResult = resolveTrackPitchCopy({ track, approvedDna });
  if (!resolved.ok) {
    return {
      ok: false,
      code: "missing_track_pitch_copy",
      message:
        "No pitch copy configured for this track — set short_pitch / approved Song DNA before send.",
      draftId,
    };
  }

  const currentHash = await hashPitchCopy(resolved.pitch);
  const storedHash = String(draft.pitch_copy_hash ?? "").trim();
  const body = String(draft.body ?? "");

  if (storedHash) {
    if (storedHash !== currentHash) {
      return {
        ok: false,
        code: "pitch_copy_changed",
        message:
          `Draft ${draftId}: the track's pitch copy changed after this draft was approved. ` +
          "Regenerate this draft — do not send the stale approved body.",
        draftId,
        expectedHash: storedHash,
        currentHash,
      };
    }
  } else {
    // Legacy approved rows (pre-hash): body must still contain today's resolved pitch.
    const needle = normalizePitchCopy(resolved.pitch);
    const haystack = normalizePitchCopy(body);
    if (!needle || !haystack.includes(needle)) {
      return {
        ok: false,
        code: "pitch_copy_stale_legacy",
        message:
          `Draft ${draftId}: stored body no longer matches the track's current pitch copy. ` +
          "Regenerate this draft — the approved artefact is stale.",
        draftId,
        expectedHash: null,
        currentHash,
      };
    }
  }

  return {
    ok: true,
    pitch: resolved.pitch,
    source: resolved.source,
    hash: currentHash,
    songDnaVersionId: resolved.songDnaVersionId,
  };
}

export type StaleDraftRow = {
  id: string;
  track_id: string | null;
  track_name: string;
  status: string;
  reason: string;
  pitch_copy_hash: string | null;
};

/**
 * Find approved drafts whose stored pitch provenance no longer matches live copy.
 * Does not mutate unless apply=true (then status → superseded).
 */
export async function findStaleApprovedDrafts(
  sb: SupabaseClient,
  opts: { trackId?: string | null; limit?: number } = {},
): Promise<{ scanned: number; stale: StaleDraftRow[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 10000);
  let q = sb
    .from("outreach_drafts")
    .select("id, track_id, track_name, status, body, pitch_copy_hash, pitch_copy_source, song_dna_version_id")
    .eq("status", "approved")
    .order("generated_at", { ascending: false })
    .limit(limit);
  if (opts.trackId) q = q.eq("track_id", opts.trackId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const stale: StaleDraftRow[] = [];
  for (const row of rows) {
    const check = await verifyDraftPitchIntegrity(sb, row);
    if (!check.ok) {
      stale.push({
        id: String(row.id),
        track_id: row.track_id ? String(row.track_id) : null,
        track_name: String(row.track_name ?? ""),
        status: String(row.status ?? ""),
        reason: check.code,
        pitch_copy_hash: row.pitch_copy_hash ? String(row.pitch_copy_hash) : null,
      });
    }
  }
  return { scanned: rows.length, stale };
}
