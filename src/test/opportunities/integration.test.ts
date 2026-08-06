import { describe, it, expect } from "vitest";
import { createOpportunityRepository } from "@/lib/opportunities/repository";
import { validateClip } from "@/lib/opportunities/outcomes";
import { createStubClient } from "./stubClient";

// MANDATORY integration proof: ONE seeded workflow that actually runs end to end
// through the SAME service/repository code the edge function calls —
//   song (tracks + intelligence profile + approved clip)
//     -> entity -> scored opportunity -> Opportunity Inbox listing
//     -> generate action -> status action -> outcome -> relationship history -> recalc
// This is what proves the pieces are wired together, not just individually present.
describe("Opportunity Engine — seeded end-to-end integration", () => {
  it("runs song -> entity -> scored opportunity -> inbox -> action -> outcome -> relationship memory", async () => {
    // --- 1. Seed a REAL song (tracks), intelligence profile, and approved clip.
    const SONG_ID = "track-dfm";
    const client = createStubClient({
      tracks: [{ id: SONG_ID, name: "Designed For Me", status: "active", duration_seconds: 200 }],
      song_intelligence_profiles: [
        { track_id: SONG_ID, bpm: 122, musical_key: "A", mode: "minor", energy: 0.7, genre_tags: ["deep house"], mood_tags: ["euphoric"] },
      ],
      song_clips: [{ track_id: SONG_ID, label: "drop", start_seconds: 64, end_seconds: 88, status: "approved" }],
    });
    const repo = createOpportunityRepository(client as never);

    // The seeded clip is valid against the track length (service-level guard).
    expect(validateClip(64, 88, 200)).toEqual({ ok: true });

    // --- 2. Entity (normalized + deduped).
    const { entity, created: entityCreated } = await repo.findOrCreateEntity({
      entity_type: "playlist",
      name: "Deep House Vibes",
      platform: "spotify",
      platform_external_id: "37iABC",
      metadata: { genre_tags: ["deep house"] },
    });
    expect(entityCreated).toBe(true);

    // --- 3. Opportunity created AND scored.
    const { opportunity, created } = await repo.createOpportunity({
      entity_id: entity.id,
      opportunity_type: "playlist_pitch",
      title: "Pitch Designed For Me to Deep House Vibes",
      source_platform: "spotify",
      recommended_song_id: SONG_ID,
      recommended_start_seconds: 64,
      recommended_end_seconds: 88,
      why_discovered: "Genre + mood match on deep house",
      scoreInput: { audienceFit: 0.9, audienceSize: 50000, warmth: 0.4, hasContact: true },
    });
    expect(created).toBe(true);
    expect(opportunity.opportunity_score).toBeGreaterThan(0);
    expect(opportunity.audience_match_score).toBe(90); // 0.9 audience fit -> 90

    // --- 4. It APPEARS IN THE INBOX (listOpportunities is exactly the UI's data source).
    const inbox = await repo.listOpportunities({ status: ["new"] }, { order: "score" });
    const card = inbox.rows.find((r) => r.id === opportunity.id);
    expect(card).toBeTruthy();
    expect(inbox.total).toBeGreaterThanOrEqual(1);
    expect(card.entity.name).toBe("Deep House Vibes"); // entity embedded for the card

    // --- 5. Generate action (recommended action + draft message stored; real song name).
    const withAction = await repo.generateAction(opportunity.id, { userId: "admin", kind: "user" });
    expect(withAction.recommended_action).toBeTruthy();
    expect(withAction.generated_message).toContain("Designed For Me");
    expect(withAction.generated_message).toContain("Deep House Vibes");

    // --- 6. Action recorded (approve -> contacted), audited in opportunity_actions.
    await repo.transition(opportunity.id, "approved", { userId: "admin", kind: "user" });
    await repo.transition(opportunity.id, "contacted", { userId: "admin", kind: "user" });
    const actions = client._tables.opportunity_actions ?? [];
    expect(actions.some((a) => a.action_type === "generate_message")).toBe(true);
    expect(actions.some((a) => a.action_type === "status:approved")).toBe(true);
    expect(actions.some((a) => a.action_type === "status:contacted")).toBe(true);

    const relScoreBefore = (await repo.getOpportunity(opportunity.id)).relationship_score ?? 0;

    // --- 7. Outcomes recorded -> RELATIONSHIP HISTORY updates -> score recalcs.
    await repo.recordOutcome(opportunity.id, { outcome_type: "responded", response_received: true }, { userId: "admin", kind: "user" });
    const conv = await repo.recordOutcome(
      opportunity.id,
      { outcome_type: "converted", converted: true, conversion_value: 250 },
      { userId: "admin", kind: "user" },
    );

    // outcomes persisted
    expect((client._tables.opportunity_outcomes ?? []).length).toBe(2);
    expect(typeof conv.score === "number").toBe(true);

    // relationship history was written by the outcomes
    const relEvents = client._tables.growth_relationship_events ?? [];
    expect(relEvents.some((e) => e.event_type === "replied")).toBe(true);
    expect(relEvents.some((e) => e.event_type === "converted")).toBe(true);

    // memory aggregates and feeds back into the score component (closed loop)
    const summary = await repo.aggregateRelationshipForEntity(entity.id);
    expect(summary.replied).toBe(1);
    expect(summary.score).toBeGreaterThan(0);

    const final = await repo.getOpportunity(opportunity.id);
    expect(final.status).toBe("converted");
    expect(final.relationship_score).toBeGreaterThan(relScoreBefore);

    // --- 8. Stats reflect the live rows (what the inbox header shows).
    const stats = await repo.stats();
    expect(stats.total).toBe(1);
    expect(stats.by_status.converted).toBe(1);
  });
});
