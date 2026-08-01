// Opportunity Engine — DETERMINISTIC scoring.
//
// There is NO machine-learning model here and none is implied. Every number is a
// documented, reproducible function of the input signals. Weights are CONFIGURABLE
// (pass a partial override to compositeScore / scoreOpportunity). The eight
// components are computed and stored SEPARATELY from the composite so a human can
// see exactly why an opportunity scored the way it did, and so a future learning
// pass can adjust weights without discarding the components.
//
// Scale convention: every component AND the composite are 0..100.
//   * "probability" components are the modeled probability × 100.
//   * effort_score and risk_score are "bad-is-high": 100 = maximum effort/risk.
//     The composite INVERTS them (a high-effort / high-risk opportunity scores
//     lower), so all eight components read on the same "higher raw value" axis
//     inside their own field while the blend handles the polarity.

import type { ScoreComponents, ScoreInput, ScoreWeights } from "./types.ts";

export function clamp(n: number, lo = 0, hi = 100): number {
  // NaN is treated as the low bound; ±Infinity clamp naturally to hi / lo.
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Default component weights. They sum to 1.00 for readability, but the blend
 * normalizes by the actual sum, so any positive weights are valid.
 *
 *   audience_match        0.20  is this the right audience for this song
 *   relationship          0.20  do we already have a warm relationship
 *   reach                 0.15  how many people it could reach
 *   response_probability  0.12  will they even reply
 *   conversion_probability0.12  if they reply, will it convert
 *   lifetime_value        0.11  how much a conversion is worth
 *   effort   (inverted)   0.05  penalize high-effort plays
 *   risk     (inverted)   0.05  penalize risky plays (fraud / pay-to-play)
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  audience_match_score: 0.2,
  relationship_score: 0.2,
  reach_score: 0.15,
  response_probability: 0.12,
  conversion_probability: 0.12,
  lifetime_value_score: 0.11,
  effort_score: 0.05,
  risk_score: 0.05,
};

const NEUTRAL = 50;

/** ln-scaled reach: 0 at 0 followers, ~100 near 10M. */
export function reachFromAudience(audienceSize?: number | null): number {
  if (!audienceSize || audienceSize <= 0) return 0;
  const scaled = Math.log(audienceSize) / Math.log(10_000_000);
  return clamp(scaled * 100);
}

/**
 * Derive the eight components from raw signals. Absent signals fall back to a
 * documented neutral (never fabricated), so a barely-known opportunity lands
 * mid-scale rather than being silently treated as great or worthless.
 */
export function computeScoreComponents(input: ScoreInput): ScoreComponents {
  const audience_match_score =
    input.audienceFit == null ? NEUTRAL : clamp(input.audienceFit * 100);

  const relationship_score =
    input.relationshipScore == null ? 0 : clamp(input.relationshipScore);

  const reach_score = reachFromAudience(input.audienceSize);

  // Warmth drives whether they reply at all. No-contact caps it hard.
  const warmth = input.warmth == null ? 0.2 : clamp(input.warmth, 0, 1);
  const contactPenalty = input.hasContact === false ? 0.4 : 1;
  const response_probability = clamp(warmth * contactPenalty * 100);

  // Conversion is gated by response: you can't convert someone who never replied.
  const historic = input.historicConversion == null ? 0.15 : clamp(input.historicConversion, 0, 1);
  const conversion_probability = clamp((response_probability / 100) * historic * 100);

  // Effort: default moderate; missing contact means more manual work.
  const rawEffort = input.effort == null ? 0.5 : clamp(input.effort, 0, 1);
  const effort_score = clamp((input.hasContact === false ? Math.max(rawEffort, 0.7) : rawEffort) * 100);

  // Risk: default low-moderate when unknown.
  const risk_score = input.risk == null ? 20 : clamp(input.risk * 100);

  // Lifetime value: blend a known dollar ceiling (log-scaled to $10k) with the
  // reach×conversion expectation, so value tracks both money and likely outcome.
  const ceiling = input.valueCeiling && input.valueCeiling > 0
    ? clamp((Math.log(input.valueCeiling) / Math.log(10_000)) * 100)
    : NEUTRAL;
  const expected = (reach_score / 100) * (conversion_probability / 100) * 100;
  const lifetime_value_score = clamp(0.5 * ceiling + 0.5 * expected);

  return {
    audience_match_score,
    relationship_score,
    reach_score,
    response_probability,
    conversion_probability,
    effort_score,
    lifetime_value_score,
    risk_score,
  };
}

/**
 * Blend the eight components into a single 0..100 opportunity score. effort_score
 * and risk_score are inverted (100 - value) before weighting. Normalized by the
 * sum of weights so custom weight configs need not sum to 1.
 */
export function compositeScore(
  c: ScoreComponents,
  weights: Partial<ScoreWeights> = {},
): number {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const contributions: Array<[number, number]> = [
    [w.audience_match_score, c.audience_match_score],
    [w.relationship_score, c.relationship_score],
    [w.reach_score, c.reach_score],
    [w.response_probability, c.response_probability],
    [w.conversion_probability, c.conversion_probability],
    [w.lifetime_value_score, c.lifetime_value_score],
    [w.effort_score, 100 - c.effort_score], // inverted: less effort scores higher
    [w.risk_score, 100 - c.risk_score], // inverted: less risk scores higher
  ];
  let weighted = 0;
  let total = 0;
  for (const [weight, value] of contributions) {
    const safe = Math.max(0, weight);
    weighted += safe * clamp(value);
    total += safe;
  }
  if (total <= 0) return 0;
  return Math.round((weighted / total) * 100) / 100;
}

export interface ScoredOpportunity {
  components: ScoreComponents;
  opportunity_score: number;
}

/** One-shot: signals -> components -> composite. */
export function scoreOpportunity(
  input: ScoreInput,
  weights: Partial<ScoreWeights> = {},
): ScoredOpportunity {
  const components = computeScoreComponents(input);
  return { components, opportunity_score: compositeScore(components, weights) };
}

/**
 * Effective score respecting a human override. When an operator pins a score we
 * trust the human; the computed composite is retained separately for audit.
 */
export function effectiveScore(opp: {
  score_overridden?: boolean | null;
  manual_score?: number | null;
  opportunity_score?: number | null;
}): number | null {
  if (opp.score_overridden && opp.manual_score != null) return clamp(opp.manual_score);
  return opp.opportunity_score == null ? null : clamp(opp.opportunity_score);
}
