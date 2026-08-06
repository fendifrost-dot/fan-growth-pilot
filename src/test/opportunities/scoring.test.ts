import { describe, it, expect } from "vitest";
import {
  clamp,
  compositeScore,
  computeScoreComponents,
  DEFAULT_WEIGHTS,
  effectiveScore,
  reachFromAudience,
  scoreOpportunity,
} from "@/lib/opportunities/scoring";

describe("opportunity scoring — deterministic", () => {
  it("clamps to 0..100 and rejects NaN/Infinity", () => {
    expect(clamp(150)).toBe(100);
    expect(clamp(-5)).toBe(0);
    expect(clamp(Number.NaN)).toBe(0);
    expect(clamp(Infinity)).toBe(100);
  });

  it("reach is 0 at zero audience and 100 at 10M", () => {
    expect(reachFromAudience(0)).toBe(0);
    expect(reachFromAudience(null)).toBe(0);
    expect(reachFromAudience(10_000_000)).toBe(100);
    // Monotonic increasing.
    expect(reachFromAudience(1_000)).toBeLessThan(reachFromAudience(100_000));
  });

  it("produces the documented neutral components for empty input", () => {
    const c = computeScoreComponents({});
    expect(c).toEqual({
      audience_match_score: 50,
      relationship_score: 0,
      reach_score: 0,
      response_probability: 20,
      conversion_probability: 3,
      effort_score: 50,
      lifetime_value_score: 25,
      risk_score: 20,
    });
  });

  it("composites the neutral vector to a stable, reproducible score", () => {
    const { opportunity_score } = scoreOpportunity({});
    // Hand-computed golden: weighted sum 22.01 over total weight 1.00.
    expect(opportunity_score).toBe(22.01);
  });

  it("weights sum to 1.00 by default (readability) but blend normalizes anyway", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 100) / 100).toBe(1);
    // Doubling every weight must not change the normalized composite.
    const c = computeScoreComponents({ audienceFit: 0.8, warmth: 0.6 });
    const doubled = { ...DEFAULT_WEIGHTS };
    (Object.keys(doubled) as (keyof typeof doubled)[]).forEach((k) => {
      doubled[k] = doubled[k] * 2;
    });
    expect(compositeScore(c, doubled)).toBe(compositeScore(c));
  });

  it("inverts effort and risk (lower is better)", () => {
    const base = computeScoreComponents({ audienceFit: 0.5, warmth: 0.5 });
    const lowRisk = compositeScore({ ...base, risk_score: 0 });
    const highRisk = compositeScore({ ...base, risk_score: 100 });
    expect(lowRisk).toBeGreaterThan(highRisk);
    const lowEffort = compositeScore({ ...base, effort_score: 0 });
    const highEffort = compositeScore({ ...base, effort_score: 100 });
    expect(lowEffort).toBeGreaterThan(highEffort);
  });

  it("a warm, on-target, high-reach opportunity scores far above neutral", () => {
    const strong = scoreOpportunity({
      audienceFit: 1,
      relationshipScore: 90,
      audienceSize: 1_000_000,
      warmth: 1,
      historicConversion: 0.6,
      effort: 0.1,
      risk: 0.05,
      valueCeiling: 5000,
      hasContact: true,
    });
    expect(strong.opportunity_score).toBeGreaterThan(60);
    for (const v of Object.values(strong.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("missing contact suppresses response and raises effort", () => {
    const withContact = computeScoreComponents({ warmth: 0.8, hasContact: true });
    const without = computeScoreComponents({ warmth: 0.8, hasContact: false });
    expect(without.response_probability).toBeLessThan(withContact.response_probability);
    expect(without.effort_score).toBeGreaterThanOrEqual(70);
  });

  it("effectiveScore honours a human override", () => {
    expect(effectiveScore({ opportunity_score: 40 })).toBe(40);
    expect(effectiveScore({ opportunity_score: 40, score_overridden: true, manual_score: 88 })).toBe(88);
    expect(effectiveScore({ opportunity_score: null })).toBeNull();
  });
});
