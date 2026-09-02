/**
 * Designed For Me (Control) — same-track / same-target hard block (client/shared).
 * Mirrors supabase/functions/_shared/control-cooldown.ts for unit tests and UI.
 */

export const CONTROL_TRACK_ID = "5d09da7e-98cf-4276-8dca-861d1fbbfa98";
export const CONTROL_COOLDOWN_UNTIL_DATE = "2026-09-14";

export function controlCooldownEndsAt(): Date {
  return new Date("2026-09-15T04:59:59.999Z");
}

export function isControlCooldownActive(now: Date = new Date()): boolean {
  return now.getTime() <= controlCooldownEndsAt().getTime();
}

export function isControlTrackId(trackId: string | null | undefined): boolean {
  return String(trackId ?? "").trim().toLowerCase() === CONTROL_TRACK_ID;
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
    String(opts.trackName ?? "").toLowerCase().includes("designed for me");
  if (!isControl) return { blocked: false };
  if (!isControlCooldownActive(now)) return { blocked: false };
  if (!opts.priorPitchExists) return { blocked: false };

  const until = controlCooldownEndsAt().toISOString();
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

/** Month-one MEDITATE licensing candidate copy — never implies sync approval. */
export const MONTH1_CANDIDATE_NOTICE =
  "Month-one candidate — not approved for sync submission until Fendi completes DNA, sample, rights, splits, assets, and sync approval.";
