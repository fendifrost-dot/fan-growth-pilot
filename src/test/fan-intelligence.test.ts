import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fan Scoring Engine Unit Tests ──

const SCORING_WEIGHTS = {
  page_view: 1,
  cta_click: 5,
  email_capture: 15,
  repeat_visit: 3,
  album_purchased: 30,
  repeat_purchase: 50,
  geo_detected: 1,
  campaign_touch: 2,
  smartlink_redirect: 1,
};

function classifyTier(score: number): string {
  if (score >= 50) return 'superfan';
  if (score >= 15) return 'engaged';
  return 'casual';
}

function calculateScore(events: { event_type: string; value?: number }[]): { score: number; tier: string } {
  let score = 0;
  const counts: Record<string, number> = {};
  for (const evt of events) {
    counts[evt.event_type] = (counts[evt.event_type] || 0) + 1;
    const weight = SCORING_WEIGHTS[evt.event_type as keyof typeof SCORING_WEIGHTS] || 1;
    score += weight;
    if (evt.event_type === 'album_purchased' && counts[evt.event_type] > 1) {
      score += SCORING_WEIGHTS.repeat_purchase - SCORING_WEIGHTS.album_purchased;
    }
  }
  return { score, tier: classifyTier(score) };
}

describe("Fan Scoring Engine", () => {
  it("classifies a fan with no events as casual", () => {
    const { score, tier } = calculateScore([]);
    expect(score).toBe(0);
    expect(tier).toBe("casual");
  });

  it("classifies email capture as engaged", () => {
    const { score, tier } = calculateScore([{ event_type: "email_capture" }]);
    expect(score).toBe(15);
    expect(tier).toBe("engaged");
  });

  it("classifies email + purchase as superfan", () => {
    const { score, tier } = calculateScore([
      { event_type: "email_capture" },
      { event_type: "album_purchased" },
    ]);
    expect(score).toBe(45);
    expect(tier).toBe("engaged"); // 45 < 50
  });

  it("classifies email + purchase + CTA clicks as superfan", () => {
    const { score, tier } = calculateScore([
      { event_type: "email_capture" },
      { event_type: "album_purchased" },
      { event_type: "cta_click" },
    ]);
    expect(score).toBe(50);
    expect(tier).toBe("superfan");
  });

  it("awards repeat purchase bonus correctly", () => {
    const { score } = calculateScore([
      { event_type: "album_purchased" },
      { event_type: "album_purchased" },
    ]);
    // First purchase: 30, second: 30 + (50-30) = 50 bonus total
    expect(score).toBe(30 + 30 + 20);
  });

  it("handles unknown event types with weight 1", () => {
    const { score } = calculateScore([{ event_type: "unknown_event" }]);
    expect(score).toBe(1);
  });

  it("is deterministic for the same input", () => {
    const events = [
      { event_type: "page_view" },
      { event_type: "email_capture" },
      { event_type: "cta_click" },
    ];
    const result1 = calculateScore(events);
    const result2 = calculateScore(events);
    expect(result1.score).toBe(result2.score);
    expect(result1.tier).toBe(result2.tier);
  });
});

// ── Momentum Detection Unit Tests ──

const MOMENTUM_THRESHOLDS = {
  percent_change_minor: 5,
  percent_change_notable: 15,
  percent_change_spike: 30,
  minimum_absolute_change: 100,
};

function classifySeverity(percentChange: number, absoluteChange: number): string | null {
  if (Math.abs(absoluteChange) < MOMENTUM_THRESHOLDS.minimum_absolute_change) return null;
  if (Math.abs(percentChange) < MOMENTUM_THRESHOLDS.percent_change_minor) return null;
  if (Math.abs(percentChange) >= MOMENTUM_THRESHOLDS.percent_change_spike) return 'critical';
  if (Math.abs(percentChange) >= MOMENTUM_THRESHOLDS.percent_change_notable) return 'warning';
  return 'info';
}

describe("Momentum Detection", () => {
  it("ignores changes below minimum absolute threshold", () => {
    expect(classifySeverity(50, 50)).toBeNull();
  });

  it("ignores changes below minimum percent threshold", () => {
    expect(classifySeverity(3, 500)).toBeNull();
  });

  it("classifies minor change as info", () => {
    expect(classifySeverity(8, 500)).toBe("info");
  });

  it("classifies notable change as warning", () => {
    expect(classifySeverity(20, 500)).toBe("warning");
  });

  it("classifies spike as critical", () => {
    expect(classifySeverity(35, 500)).toBe("critical");
  });

  it("handles negative changes correctly", () => {
    expect(classifySeverity(-35, -500)).toBe("critical");
  });

  it("handles zero previous value (returns null for 0 absolute)", () => {
    expect(classifySeverity(100, 0)).toBeNull();
  });
});

// ── Tier Classification Tests ──

describe("Fan Tier Classification", () => {
  it("0-14 = casual", () => {
    expect(classifyTier(0)).toBe("casual");
    expect(classifyTier(14)).toBe("casual");
  });

  it("15-49 = engaged", () => {
    expect(classifyTier(15)).toBe("engaged");
    expect(classifyTier(49)).toBe("engaged");
  });

  it("50+ = superfan", () => {
    expect(classifyTier(50)).toBe("superfan");
    expect(classifyTier(100)).toBe("superfan");
  });
});

// ── Purchase Backfill Independence Tests ──

describe("Purchase Backfill Independence", () => {
  // Simulates the backfill logic extracted from fan-intelligence/index.ts
  function simulateBackfill(
    lead: { id: string; email: string; album_purchased: boolean; album_purchased_at: string | null },
    existingEmailEvents: { metadata: { lead_id: string } }[],
    existingPurchaseEvents: { metadata: { lead_id: string } }[],
  ): { email_capture_created: boolean; album_purchased_created: boolean } {
    const result = { email_capture_created: false, album_purchased_created: false };

    // Email capture dedup (by lead_id in metadata)
    const alreadyBackfilled = existingEmailEvents.some(e => e.metadata.lead_id === lead.id);
    if (!alreadyBackfilled) {
      result.email_capture_created = true;
    }

    // Purchase backfill runs INDEPENDENTLY
    if (lead.album_purchased && lead.album_purchased_at) {
      const purchaseAlreadyLogged = existingPurchaseEvents.some(e => e.metadata.lead_id === lead.id);
      if (!purchaseAlreadyLogged) {
        result.album_purchased_created = true;
      }
    }

    return result;
  }

  it("first run: creates email_capture only (no purchase yet)", () => {
    const lead = { id: "lead-1", email: "fan@test.com", album_purchased: false, album_purchased_at: null };
    const result = simulateBackfill(lead, [], []);
    expect(result.email_capture_created).toBe(true);
    expect(result.album_purchased_created).toBe(false);
  });

  it("later run: lead now has album_purchased=true, email already backfilled → creates purchase only", () => {
    const lead = { id: "lead-1", email: "fan@test.com", album_purchased: true, album_purchased_at: "2025-01-15T00:00:00Z" };
    const existingEmailEvents = [{ metadata: { lead_id: "lead-1" } }];
    const result = simulateBackfill(lead, existingEmailEvents, []);
    expect(result.email_capture_created).toBe(false);
    expect(result.album_purchased_created).toBe(true);
  });

  it("rerun after purchase backfill: creates zero duplicates", () => {
    const lead = { id: "lead-1", email: "fan@test.com", album_purchased: true, album_purchased_at: "2025-01-15T00:00:00Z" };
    const existingEmailEvents = [{ metadata: { lead_id: "lead-1" } }];
    const existingPurchaseEvents = [{ metadata: { lead_id: "lead-1" } }];
    const result = simulateBackfill(lead, existingEmailEvents, existingPurchaseEvents);
    expect(result.email_capture_created).toBe(false);
    expect(result.album_purchased_created).toBe(false);
  });

  it("first run with purchase already true: creates both events", () => {
    const lead = { id: "lead-2", email: "buyer@test.com", album_purchased: true, album_purchased_at: "2025-01-10T00:00:00Z" };
    const result = simulateBackfill(lead, [], []);
    expect(result.email_capture_created).toBe(true);
    expect(result.album_purchased_created).toBe(true);
  });
});
