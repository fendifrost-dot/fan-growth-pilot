import { describe, it, expect } from "vitest";
import {
  assertTransition,
  canTransition,
  deriveOutcomeState,
  IllegalTransitionError,
  outcomeScoreSignals,
  STATUS_TRANSITIONS,
  validateClip,
} from "@/lib/opportunities/outcomes";
import { OPPORTUNITY_STATUSES } from "@/lib/opportunities/types";
import type { OpportunityStatus } from "@/lib/opportunities/types";

// Independent SPEC of the lifecycle matrix (not derived from the implementation),
// kept identical to the DB guard `growth_opportunity_transition_allowed` in the
// Phase-1 migration. The two exhaustive tests below assert canTransition matches
// this spec for ALL 10×10 pairs, catching drift on either side.
const ALLOWED: Record<OpportunityStatus, OpportunityStatus[]> = {
  new: ["reviewing", "approved", "rejected", "snoozed"],
  reviewing: ["approved", "rejected", "snoozed"],
  approved: ["in_progress", "contacted", "snoozed", "rejected"],
  snoozed: ["new", "reviewing", "approved", "rejected"],
  in_progress: ["contacted", "closed", "rejected"],
  contacted: ["responded", "closed"],
  responded: ["converted", "closed"],
  converted: ["closed"],
  rejected: [],
  closed: [],
};

describe("transition matrix — exhaustive (mirrors the DB guard trigger)", () => {
  // NOTE: the DB-level trigger cannot run against the in-memory stub; this covers
  // the shared matrix function directly, and the runbook's live e2e exercises the
  // trigger itself with one allowed and one forbidden transition.
  it("every ALLOWED transition (and same-status no-op) passes canTransition", () => {
    for (const from of OPPORTUNITY_STATUSES) {
      expect(canTransition(from, from)).toBe(true); // idempotent
      for (const to of ALLOWED[from]) expect(canTransition(from, to)).toBe(true);
    }
  });

  it("every FORBIDDEN transition is rejected across all 10×10 pairs", () => {
    for (const from of OPPORTUNITY_STATUSES) {
      for (const to of OPPORTUNITY_STATUSES) {
        if (from === to) continue; // same-status covered above
        expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
      }
    }
  });
});

describe("status transitions", () => {
  it("allows documented forward moves", () => {
    expect(canTransition("new", "approved")).toBe(true);
    expect(canTransition("approved", "contacted")).toBe(true);
    expect(canTransition("contacted", "responded")).toBe(true);
    expect(canTransition("responded", "converted")).toBe(true);
  });

  it("is idempotent for same-state", () => {
    expect(canTransition("new", "new")).toBe(true);
  });

  it("forbids illegal jumps and reopening terminals", () => {
    expect(canTransition("new", "converted")).toBe(false);
    expect(canTransition("approved", "converted")).toBe(false);
    expect(canTransition("rejected", "new")).toBe(false);
    expect(canTransition("closed", "approved")).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    expect(STATUS_TRANSITIONS.rejected).toEqual([]);
    expect(STATUS_TRANSITIONS.closed).toEqual([]);
  });

  it("assertTransition throws a typed error on illegal moves", () => {
    expect(() => assertTransition("new", "converted")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("new", "approved")).not.toThrow();
  });
});

describe("song clip validation", () => {
  it("accepts a positive ordered window inside the track", () => {
    expect(validateClip(10, 25, 180)).toEqual({ ok: true });
  });
  it("rejects non-ordered or negative windows", () => {
    expect(validateClip(25, 10).ok).toBe(false);
    expect(validateClip(-1, 5).ok).toBe(false);
    expect(validateClip(5, 5).ok).toBe(false);
  });
  it("rejects a window past the track length", () => {
    const r = validateClip(120, 200, 180);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exceeds track length/);
  });
  it("requires whole seconds", () => {
    expect(validateClip(1.5, 10).ok).toBe(false);
  });
  it("validates ordering only when duration is unknown", () => {
    expect(validateClip(10, 20).ok).toBe(true);
  });
});

describe("outcome derivation", () => {
  it("derives the furthest realized state from the timeline", () => {
    const s = deriveOutcomeState([
      { outcome_type: "contacted" },
      { outcome_type: "responded", response_received: true },
    ]);
    expect(s.contacted).toBe(true);
    expect(s.responded).toBe(true);
    expect(s.converted).toBe(false);
    expect(s.derivedStatus).toBe("responded");
  });

  it("a conversion implies response and contact and captures value", () => {
    const s = deriveOutcomeState([
      { outcome_type: "converted", converted: true, conversion_value: 250 },
    ]);
    expect(s.converted).toBe(true);
    expect(s.responded).toBe(true);
    expect(s.contacted).toBe(true);
    expect(s.conversionValue).toBe(250);
    expect(s.derivedStatus).toBe("converted");
  });

  it("no outcomes -> no derived status", () => {
    expect(deriveOutcomeState([]).derivedStatus).toBeNull();
  });

  it("feeds learning signals back into scoring", () => {
    const sig = outcomeScoreSignals([{ outcome_type: "converted", converted: true, conversion_value: 500 }]);
    expect(sig.warmth).toBe(1);
    expect(sig.historicConversion).toBe(1);
    expect(sig.valueCeiling).toBe(500);
  });
});
