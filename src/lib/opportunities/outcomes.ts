// Opportunity Engine — status transitions, clip validation, outcome derivation.

import type { OpportunityStatus, OutcomeRow, OutcomeState } from "./types.ts";

/**
 * Legal opportunity lifecycle. Enforced here (service) so the API and any future
 * scheduler share ONE definition, mirroring the DB-level guard on pitch_campaigns.
 * Terminal states (rejected, closed, converted->closed) cannot silently reopen.
 */
export const STATUS_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  new: ["reviewing", "approved", "rejected", "snoozed"],
  reviewing: ["approved", "rejected", "snoozed"],
  approved: ["in_progress", "contacted", "snoozed", "rejected"],
  snoozed: ["new", "reviewing", "approved", "rejected"],
  in_progress: ["contacted", "closed", "rejected"],
  contacted: ["responded", "closed"],
  responded: ["converted", "closed"],
  converted: ["closed"],
  rejected: [], // terminal
  closed: [], // terminal
};

export function canTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  if (from === to) return true; // idempotent no-op
  return (STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(public from: OpportunityStatus, public to: OpportunityStatus) {
    super(`Illegal opportunity transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: OpportunityStatus, to: OpportunityStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Song clip validation
// ---------------------------------------------------------------------------

export interface ClipValidation {
  ok: boolean;
  error?: string;
}

/**
 * A clip must be a positive, ordered window that fits inside the track. When the
 * track duration is unknown we validate ordering only (cannot check the upper
 * bound without fabricating a length).
 */
export function validateClip(
  startSeconds: number,
  endSeconds: number,
  durationSeconds?: number | null,
): ClipValidation {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return { ok: false, error: "start/end must be finite numbers" };
  }
  if (!Number.isInteger(startSeconds) || !Number.isInteger(endSeconds)) {
    return { ok: false, error: "start/end must be whole seconds" };
  }
  if (startSeconds < 0) return { ok: false, error: "start must be >= 0" };
  if (endSeconds <= startSeconds) return { ok: false, error: "end must be after start" };
  if (durationSeconds != null && endSeconds > durationSeconds) {
    return { ok: false, error: `end ${endSeconds}s exceeds track length ${durationSeconds}s` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Outcome derivation
// ---------------------------------------------------------------------------

/**
 * Fold an opportunity's outcome rows into current state. Append-only outcomes let
 * us keep the full timeline; the derived status is the furthest point reached.
 */
export function deriveOutcomeState(outcomes: OutcomeRow[]): OutcomeState {
  let contacted = false;
  let responded = false;
  let converted = false;
  let conversionValue = 0;
  let latestOutcomeAt: string | null = null;

  for (const o of outcomes) {
    const type = o.outcome_type;
    if (type === "contacted") contacted = true;
    if (o.response_received || type === "responded" || type === "positive" || type === "negative") {
      responded = true;
      contacted = true;
    }
    if (o.converted || type === "converted" || type === "closed_won") {
      converted = true;
      responded = true;
      contacted = true;
    }
    if (o.conversion_value && o.conversion_value > conversionValue) {
      conversionValue = o.conversion_value;
    }
    const ts = o.created_at ?? o.converted_at ?? o.responded_at ?? null;
    if (ts && (!latestOutcomeAt || ts > latestOutcomeAt)) latestOutcomeAt = ts;
  }

  let derivedStatus: OutcomeState["derivedStatus"] = null;
  if (converted) derivedStatus = "converted";
  else if (responded) derivedStatus = "responded";
  else if (contacted) derivedStatus = "contacted";

  return { contacted, responded, converted, conversionValue, latestOutcomeAt, derivedStatus };
}

/**
 * Signals extracted from realized outcomes, fed back into scoring on recalc so the
 * score reflects what actually happened (the seed of the Phase-6 learning loop).
 */
export function outcomeScoreSignals(outcomes: OutcomeRow[]): {
  warmth?: number;
  historicConversion?: number;
  valueCeiling?: number;
} {
  const state = deriveOutcomeState(outcomes);
  const signals: { warmth?: number; historicConversion?: number; valueCeiling?: number } = {};
  if (state.responded) signals.warmth = state.converted ? 1 : 0.8;
  else if (state.contacted) signals.warmth = 0.3;
  if (state.converted) signals.historicConversion = 1;
  if (state.conversionValue > 0) signals.valueCeiling = state.conversionValue;
  return signals;
}
