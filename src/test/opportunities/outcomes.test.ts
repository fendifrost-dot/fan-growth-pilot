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
