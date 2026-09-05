/**
 * Designed For Me (Control) — same-track / same-target hard block (client).
 * Primary key is CONTROL track UUID only.
 */

import { TRACK_IDS } from "./catalogRules";

export const CONTROL_TRACK_ID = TRACK_IDS.CONTROL;
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
  trackId: string | null | undefined;
  playlistId: string;
  priorPitchExists: boolean;
  now?: Date;
}): ControlCooldownDecision {
  const now = opts.now ?? new Date();
  if (!isControlTrackId(opts.trackId)) return { blocked: false };
  if (!isControlCooldownActive(now)) return { blocked: false };
  if (!opts.priorPitchExists) return { blocked: false };

  const until = controlCooldownEndsAt().toISOString();
  return {
    blocked: true,
    reason: "control_same_target_cooldown",
    message:
      `Designed For Me (Control) is on a same-target hard block through ${CONTROL_COOLDOWN_UNTIL_DATE}. ` +
      `This playlist was already pitched for Control (track_id=${CONTROL_TRACK_ID}). New Control targets remain allowed.`,
    cooldown_until: until,
    track_id: CONTROL_TRACK_ID,
    playlist_id: opts.playlistId,
  };
}

export const MONTH1_CANDIDATE_NOTICE =
  "Month-one candidate — not approved for sync submission until Fendi completes DNA, sample, rights, splits, assets, and sync approval.";
