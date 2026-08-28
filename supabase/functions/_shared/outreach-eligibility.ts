// AGH P0-A — Eligibility Containment Gate (code half).
//
// The single question this module answers: "is this SONG cleared to be pitched
// to a real curator at all?" That is deliberately NOT the same question as any
// existing control on the send path:
//
//   caps / cooldowns / send window  -> HOW MUCH and WHEN we may send   (capacity)
//   verification / outreach policy  -> is this TARGET safe to contact  (target)
//   categoryGate                    -> does this pair make sense       (match)
//   THIS MODULE                     -> is this TRACK cleared at all    (containment)
//
// AGH-001: "Meditate" had no track category and no genre signal, and nothing on
// the path could refuse it — the category gate failed OPEN on absence and every
// other control is about capacity or the target. This gate closes that.
//
// TWO INVARIANTS, encoded here rather than left as comments:
//
//   1. BYPASS FLAGS NEVER BYPASS ELIGIBILITY. `test_mode`, `batch_override_cap`
//      and `ignore_send_window` each waive exactly ONE named capacity/window
//      behaviour. They may never waive eligibility, integrity, or (future)
//      envelope / prohibited / approval checks. `checkSendEligibility` takes the
//      flags as an argument for the sole purpose of demonstrably ignoring them,
//      and the tests assert that for every combination.
//
//   2. THE SEND PATH ONLY READS. Nothing here — and nothing on any normal
//      pitching task — may set a track to `eligible`. Automation may only move a
//      track to a MORE restrictive state. Promotion back to `eligible` belongs to
//      the artist-truth / human-clearance path and is out of scope for P0-A,
//      which is why this module exports no writer at all.
//
// Everything is FAIL-CLOSED: an unknown track, a null state, a database error,
// and a not-yet-applied migration all refuse the send.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/** The four states of tracks.outreach_eligibility (see the migration). */
export const OUTREACH_ELIGIBILITY_STATES = [
  "eligible",
  "needs_song_intelligence",
  "no_genre_lane",
  "blocked",
] as const;

export type OutreachEligibility = typeof OUTREACH_ELIGIBILITY_STATES[number];

/** The fail-closed default — mirrors the column DEFAULT in the migration. */
export const DEFAULT_OUTREACH_ELIGIBILITY: OutreachEligibility = "needs_song_intelligence";

/** The ONLY state that permits an outreach send. */
export const SEND_ELIGIBLE_STATE: OutreachEligibility = "eligible";

/** Columns the gate needs. Kept in one place so both call sites select the same set. */
export const ELIGIBILITY_COLUMNS =
  "id, name, outreach_eligibility, eligibility_reason, eligibility_source, eligibility_set_by, eligibility_set_at, eligibility_si_version";

/** Shape of the tracks row the gate reads. All fields optional: a row selected
 *  before the migration has been applied simply lacks them. */
export type EligibilityTrackRow = {
  id?: unknown;
  name?: unknown;
  outreach_eligibility?: unknown;
  eligibility_reason?: unknown;
  eligibility_source?: unknown;
  eligibility_si_version?: unknown;
};

/** Machine-readable refusal reasons, for logs, the 4xx body, and run ledgers. */
export type EligibilityRefusalReason =
  | "not_eligible"
  | "unknown_track"
  | "eligibility_schema_missing"
  | "eligibility_lookup_failed";

export type EligibilityDecision =
  | {
    allowed: true;
    state: "eligible";
    trackId: string | null;
    trackName: string;
  }
  | {
    allowed: false;
    /** The state we read, or null when we could not read one at all. */
    state: OutreachEligibility | null;
    reason: EligibilityRefusalReason;
    /** Operator-facing sentence — safe to put in a 4xx body and a Telegram reply. */
    message: string;
    /** tracks.eligibility_reason verbatim, when there is one. */
    trackReason: string | null;
    trackId: string | null;
    trackName: string;
  };

/** Narrow an arbitrary column value to a known state; anything else is unknown. */
export function asOutreachEligibility(value: unknown): OutreachEligibility | null {
  return (OUTREACH_ELIGIBILITY_STATES as readonly string[]).includes(String(value))
    ? String(value) as OutreachEligibility
    : null;
}

/**
 * The gate itself: `eligible` and nothing else. Deliberately not "not blocked" —
 * a state we do not recognise (a future enum value, a typo, a null) must refuse,
 * not pass.
 */
export function isSendEligible(value: unknown): boolean {
  return asOutreachEligibility(value) === SEND_ELIGIBLE_STATE;
}

/**
 * Pure decision over an already-loaded tracks row. `null` row = unknown track =
 * refuse (an unrecognised song name must never reach a curator).
 *
 * `outreach_eligibility === undefined` means the column is not there at all,
 * i.e. the code half is deployed ahead of the migration. That is reported as its
 * own reason so an operator sees "apply the migration" rather than "this song is
 * not cleared" — but it still REFUSES.
 */
export function evaluateTrackEligibility(
  track: EligibilityTrackRow | null,
  trackLabel: string,
): EligibilityDecision {
  const name = String(track?.name ?? trackLabel ?? "").trim() || trackLabel;
  const trackId = track?.id != null ? String(track.id) : null;
  const trackReason = typeof track?.eligibility_reason === "string" && track.eligibility_reason.trim()
    ? track.eligibility_reason.trim()
    : null;

  if (!track) {
    return {
      allowed: false,
      state: null,
      reason: "unknown_track",
      message:
        `Outreach refused: no catalogue track matches "${trackLabel}". A song must exist ` +
        `in tracks and be cleared (outreach_eligibility = 'eligible') before it can be pitched.`,
      trackReason: null,
      trackId: null,
      trackName: name,
    };
  }

  if (track.outreach_eligibility === undefined) {
    return {
      allowed: false,
      state: null,
      reason: "eligibility_schema_missing",
      message:
        `Outreach refused for "${name}": tracks.outreach_eligibility is missing. The P0-A ` +
        `migration has not been applied to this database yet — apply it in the Lovable SQL ` +
        `editor, then retry. Refusing rather than sending unchecked.`,
      trackReason,
      trackId,
      trackName: name,
    };
  }

  // null column value cannot happen once the migration is applied (NOT NULL
  // DEFAULT), but treat it as the fail-closed default rather than trusting it.
  const state = asOutreachEligibility(track.outreach_eligibility) ??
    (track.outreach_eligibility == null ? DEFAULT_OUTREACH_ELIGIBILITY : null);

  if (state === SEND_ELIGIBLE_STATE) {
    return { allowed: true, state: "eligible", trackId, trackName: name };
  }

  const shown = state ?? String(track.outreach_eligibility);
  return {
    allowed: false,
    state,
    reason: "not_eligible",
    message:
      `Outreach refused for "${name}": outreach_eligibility is "${shown}", not "eligible".` +
      (trackReason ? ` Reason on file: ${trackReason}` : "") +
      ` Clearing a track is a human/artist-truth action — the pitcher cannot promote it.`,
    trackReason,
    trackId,
    trackName: name,
  };
}

/** Distinguish "column/table not there" from a transient database error, so the
 *  refusal message can tell an operator which one they are looking at. */
function isMissingColumnError(err: { message?: string; code?: string } | null): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  // PostgREST surfaces an unknown column as 42703 / "column ... does not exist",
  // and an unknown embedded field as PGRST204 "column not found in schema cache".
  return err?.code === "42703" || err?.code === "PGRST204" ||
    msg.includes("does not exist") || msg.includes("schema cache");
}

async function loadTrack(
  sb: SupabaseClient,
  filter: { by: "id"; value: string } | { by: "name"; value: string },
): Promise<{ row: EligibilityTrackRow | null; error: { message?: string; code?: string } | null }> {
  const q = sb.from("tracks").select(ELIGIBILITY_COLUMNS);
  // tracks has a unique index on lower(name); ilike with no wildcards is the
  // case-insensitive exact match that index was built for.
  const scoped = filter.by === "id" ? q.eq("id", filter.value) : q.ilike("name", filter.value);
  const { data, error } = await scoped.maybeSingle();
  return { row: (data as EligibilityTrackRow | null) ?? null, error: error ?? null };
}

function lookupFailure(
  trackLabel: string,
  err: { message?: string; code?: string } | null,
): EligibilityDecision {
  if (isMissingColumnError(err)) {
    return evaluateTrackEligibility({ name: trackLabel }, trackLabel);
  }
  return {
    allowed: false,
    state: null,
    reason: "eligibility_lookup_failed",
    message:
      `Outreach refused for "${trackLabel}": could not read outreach eligibility ` +
      `(${err?.message ?? "unknown error"}). Failing closed rather than sending unchecked.`,
    trackReason: null,
    trackId: null,
    trackName: trackLabel,
  };
}

/**
 * Bypass flags accepted ONLY so that ignoring them is explicit and testable.
 * See invariant 1 at the top of this file. Adding a flag here does NOT make it
 * capable of waiving the gate — there is no branch that reads these.
 */
export type SendBypassFlags = {
  /** Waives cooldown + caps + send window for QA sends. Never eligibility. */
  testMode?: boolean;
  /** Waives the per-song and global daily caps for a catch-up batch. Never eligibility. */
  batchOverrideCap?: boolean;
  /** Waives the 10a–4p CT window for an off-hours admin send. Never eligibility. */
  ignoreSendWindow?: boolean;
  /** Present or absent, the gate applies — this closes the draft-less bypass, where a
   *  bare {playlist_id, track_name} send skipped every draft-time refusal. */
  draftId?: string | null;
};

/**
 * SEND-path gate — call at the TOP of the email send handler, before cooldown,
 * caps, and window, and OUTSIDE any `if (!testMode)` block.
 *
 * `bypass` is accepted and then deliberately unused. Do not add a branch on it.
 */
export async function checkSendEligibility(
  sb: SupabaseClient,
  trackName: string,
  bypass: SendBypassFlags = {},
): Promise<EligibilityDecision> {
  // Referenced so the parameter is unmistakably "read but never acted on", and
  // so removing it becomes a deliberate edit rather than dead-code cleanup.
  void bypass;
  const label = String(trackName ?? "").trim();
  if (!label) {
    return evaluateTrackEligibility(null, "(no track name)");
  }
  const { row, error } = await loadTrack(sb, { by: "name", value: label });
  if (error) return lookupFailure(label, error);
  return evaluateTrackEligibility(row, label);
}

/** DRAFT-path gate, by track id — the composer has already loaded the row, so
 *  prefer `evaluateTrackEligibility(track, name)` there and keep this for callers
 *  that hold only an id. */
export async function checkDraftEligibilityById(
  sb: SupabaseClient,
  trackId: string,
  trackLabel = trackId,
): Promise<EligibilityDecision> {
  const { row, error } = await loadTrack(sb, { by: "id", value: trackId });
  if (error) return lookupFailure(trackLabel, error);
  return evaluateTrackEligibility(row, trackLabel);
}

/** DRAFT-path gate, by name — for the catalogue-pick path, which resolves a song
 *  name rather than an id and would otherwise draft an uncleared track. */
export async function checkDraftEligibilityByName(
  sb: SupabaseClient,
  trackName: string,
): Promise<EligibilityDecision> {
  const label = String(trackName ?? "").trim();
  if (!label) return evaluateTrackEligibility(null, "(no track name)");
  const { row, error } = await loadTrack(sb, { by: "name", value: label });
  if (error) return lookupFailure(label, error);
  return evaluateTrackEligibility(row, label);
}

/** Structured skip record for logs / the 4xx body. Never includes recipient data. */
export function eligibilitySkipLog(
  decision: Extract<EligibilityDecision, { allowed: false }>,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gate: "outreach_eligibility",
    skip_reason: decision.reason,
    outreach_eligibility: decision.state,
    track_name: decision.trackName,
    track_id: decision.trackId,
    track_eligibility_reason: decision.trackReason,
    ...context,
  };
}
