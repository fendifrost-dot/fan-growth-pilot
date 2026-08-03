// Opportunity Engine — relationship memory aggregation.
//
// Deterministically folds a stream of growth_relationship_events into a single
// 0..100 relationship strength plus a human-readable summary. This is the
// relationship_score COMPONENT source when an opportunity's entity has no bridged
// RIE relationship; when it DOES bridge to public.relationships, the repository
// prefers the RIE's own score and uses this as the fallback / enrichment.
//
// Deterministic and documented — not a model. Event weights are additive with a
// diminishing return via a logistic squash so a warm contact saturates rather
// than growing unbounded.

import type { RelationshipEvent, RelationshipSummary } from "./types.ts";

// Default signed weights per event type. Positive = strengthens; negative = harms.
export const EVENT_WEIGHTS: Record<string, number> = {
  discovered: 1,
  viewed: 1,
  contacted: 4,
  replied: 12,
  positive_reply: 20,
  negative_reply: -8,
  placement: 30,
  converted: 30,
  referred: 15,
  unsubscribed: -25,
  bounced: -10,
  note: 0,
};

const POSITIVE = new Set(["replied", "positive_reply", "placement", "converted", "referred"]);
const NEGATIVE = new Set(["negative_reply", "unsubscribed", "bounced"]);

/** Logistic squash of an unbounded point total into 0..100. */
export function squashToScore(points: number): number {
  // k tuned so ~40 points (a reply + placement) lands around 80.
  const score = 100 / (1 + Math.exp(-points / 25));
  // Re-center so 0 points -> 0 (not 50), keeping "no signal" honest.
  const zero = 100 / (1 + Math.exp(0));
  const rescaled = ((score - zero) / (100 - zero)) * 100;
  return Math.max(0, Math.min(100, Math.round(rescaled * 100) / 100));
}

export function aggregateRelationship(events: RelationshipEvent[]): RelationshipSummary {
  let points = 0;
  let contacted = 0;
  let replied = 0;
  let positive = 0;
  let negative = 0;
  let placements = 0;
  let lastEventAt: string | null = null;

  for (const e of events) {
    const w = e.weight ?? EVENT_WEIGHTS[e.event_type] ?? 0;
    points += w;
    if (e.event_type === "contacted") contacted += 1;
    if (e.event_type === "replied" || e.event_type === "positive_reply") replied += 1;
    if (e.event_type === "placement") placements += 1;
    if (POSITIVE.has(e.event_type)) positive += 1;
    if (NEGATIVE.has(e.event_type)) negative += 1;
    if (e.occurred_at && (!lastEventAt || e.occurred_at > lastEventAt)) {
      lastEventAt = e.occurred_at;
    }
  }

  return {
    score: squashToScore(points),
    events: events.length,
    contacted,
    replied,
    positive,
    negative,
    placements,
    lastEventAt,
  };
}
