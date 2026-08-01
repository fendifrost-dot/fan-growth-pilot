import { describe, it, expect } from "vitest";
import { aggregateRelationship, EVENT_WEIGHTS, squashToScore } from "@/lib/opportunities/relationship-memory";

describe("relationship memory aggregation", () => {
  it("no events -> zero score, honest emptiness", () => {
    const s = aggregateRelationship([]);
    expect(s.score).toBe(0);
    expect(s.events).toBe(0);
    expect(s.lastEventAt).toBeNull();
  });

  it("squash is monotonic and bounded 0..100", () => {
    expect(squashToScore(0)).toBe(0);
    expect(squashToScore(1000)).toBeLessThanOrEqual(100);
    expect(squashToScore(10)).toBeLessThan(squashToScore(40));
  });

  it("counts contacts, replies, placements and tracks the latest event", () => {
    const s = aggregateRelationship([
      { event_type: "contacted", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "replied", occurred_at: "2026-02-01T00:00:00Z" },
      { event_type: "placement", occurred_at: "2026-03-01T00:00:00Z" },
    ]);
    expect(s.contacted).toBe(1);
    expect(s.replied).toBe(1);
    expect(s.placements).toBe(1);
    expect(s.positive).toBe(2); // replied + placement
    expect(s.lastEventAt).toBe("2026-03-01T00:00:00Z");
    expect(s.score).toBeGreaterThan(0);
  });

  it("negative events reduce the score relative to positive-only history", () => {
    const positive = aggregateRelationship([{ event_type: "placement" }]);
    const mixed = aggregateRelationship([{ event_type: "placement" }, { event_type: "unsubscribed" }]);
    expect(mixed.score).toBeLessThan(positive.score);
    expect(mixed.negative).toBe(1);
  });

  it("explicit per-event weight overrides the default table", () => {
    const s = aggregateRelationship([{ event_type: "note", weight: 50 }]);
    expect(EVENT_WEIGHTS.note).toBe(0);
    expect(s.score).toBeGreaterThan(0);
  });
});
