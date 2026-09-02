/**
 * Designed For Me (Control) — same-track / same-target hard block.
 *
 * Locked decision (docs/PHASE0_LOCKED_DECISIONS.md §2):
 * Exact same Control track + same target cannot be re-pitched through
 * 2026-09-14 inclusive (America/Chicago). New Control targets remain allowed.
 *
 * Primary key is the stable track UUID, not display-title matching.
 */

/** Live Hub track id for Designed For Me (Control). */
export const CONTROL_TRACK_ID = "5d09da7e-98cf-4276-8dca-861d1fbbfa98";

/** Inclusive end of cooldown in America/Chicago calendar terms. */
export const CONTROL_COOLDOWN_UNTIL_DATE = "2026-09-14";

/** End of 2026-09-14 in America/Chicago as an absolute instant. */
export function controlCooldownEndsAt(now: Date = new Date()): Date {
  // 2026-09-14 23:59:59.999 CT ≈ 2026-09-15 04:59:59.999 UTC (CDT, UTC-5)
  // Compute via a fixed offset for the known CDT date rather than Intl parsing.
  return new Date("2026-09-15T04:59:59.999Z");
}

export function isControlCooldownActive(now: Date = new Date()): boolean {
  return now.getTime() <= controlCooldownEndsAt(now).getTime();
}

export function isControlTrackId(trackId: string | null | undefined): boolean {
  return String(trackId ?? "").trim().toLowerCase() === CONTROL_TRACK_ID;
}

/** Secondary title helper for legacy pitch_log rows keyed by track_name. */
export function isControlTrackName(name: string | null | undefined): boolean {
  const n = String(name ?? "").trim().toLowerCase();
  return n.includes("designed for me");
}

export type ControlCooldownDecision =
  | { blocked: false }
  | {
      blocked: true;
      reason: "control_same_target_cooldown";
      message: string;
      cooldown_until: string;
      track_id: string;
      playlist_id: string;
    };

/**
 * Hard-block re-pitch of Control to a target that already has a sent pitch_log
 * row for Control, while the calendar cooldown is active.
 *
 * `priorPitchExists` must be true only when Hub evidence shows the same
 * playlist/target was already pitched for Control (Claude may supply missing
 * target records separately).
 */
export function evaluateControlSameTargetCooldown(opts: {
  trackId?: string | null;
  trackName?: string | null;
  playlistId: string;
  priorPitchExists: boolean;
  now?: Date;
}): ControlCooldownDecision {
  const now = opts.now ?? new Date();
  const isControl =
    isControlTrackId(opts.trackId) ||
    (Boolean(opts.trackName) && String(opts.trackName).toLowerCase().includes("designed for me"));
  if (!isControl) return { blocked: false };
  if (!isControlCooldownActive(now)) return { blocked: false };
  if (!opts.priorPitchExists) return { blocked: false };

  const until = controlCooldownEndsAt(now).toISOString();
  return {
    blocked: true,
    reason: "control_same_target_cooldown",
    message:
      `Designed For Me (Control) is on a same-target hard block through ${CONTROL_COOLDOWN_UNTIL_DATE}. ` +
      `This playlist was already pitched for Control. New Control targets remain allowed.`,
    cooldown_until: until,
    track_id: CONTROL_TRACK_ID,
    playlist_id: opts.playlistId,
  };
}
