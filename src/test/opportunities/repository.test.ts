import { describe, it, expect } from "vitest";
import { createOpportunityRepository } from "@/lib/opportunities/repository";
import { createStubClient } from "./stubClient";

function seededRepo() {
  const client = createStubClient({
    growth_entities: [
      { id: "E1", entity_type: "playlist", name: "Deep House Vibes", platform: "spotify", platform_external_id: "37iabc" },
    ],
  });
  return { client, repo: createOpportunityRepository(client as never) };
}

describe("repository — entity find-or-create (normalization + dedupe)", () => {
  it("returns the existing entity for the same normalized platform id", async () => {
    const client = createStubClient();
    const repo = createOpportunityRepository(client as never);
    const a = await repo.findOrCreateEntity({ entity_type: "playlist", name: "X", platform: "Spotify", platform_external_id: "37iABC" });
    expect(a.created).toBe(true);
    const b = await repo.findOrCreateEntity({ entity_type: "playlist", name: "X (dup)", platform: "spotify", platform_external_id: "37iabc" });
    expect(b.created).toBe(false);
    expect(b.entity.id).toBe(a.entity.id);
    expect(client._tables.growth_entities.length).toBe(1);
  });
});

describe("repository — duplicate opportunity prevention", () => {
  it("a second create with the same entity/type/song is deduped, not duplicated", async () => {
    const { client, repo } = seededRepo();
    const first = await repo.createOpportunity({
      entity_id: "E1",
      opportunity_type: "playlist_pitch",
      title: "Pitch DFM to Deep House Vibes",
      recommended_song_id: "SONG1",
      scoreInput: { audienceFit: 0.9, warmth: 0.5 },
    });
    expect(first.created).toBe(true);
    expect(first.opportunity.opportunity_score).toBeGreaterThan(0);

    const dup = await repo.createOpportunity({
      entity_id: "E1",
      opportunity_type: "playlist_pitch",
      title: "Pitch DFM again",
      recommended_song_id: "SONG1",
    });
    expect(dup.created).toBe(false);
    expect(dup.deduped).toBe(true);
    expect(client._tables.growth_opportunities.length).toBe(1);
  });

  it("a different song to the same entity is a distinct opportunity", async () => {
    const { client, repo } = seededRepo();
    await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "S1", recommended_song_id: "SONG1" });
    await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "S2", recommended_song_id: "SONG2" });
    expect(client._tables.growth_opportunities.length).toBe(2);
  });
});

describe("repository — status transitions + action audit", () => {
  it("advances a legal transition and records an action row", async () => {
    const { client, repo } = seededRepo();
    const { opportunity } = await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "T", recommended_song_id: "S" });
    const updated = await repo.transition(opportunity.id, "approved", { userId: "admin", kind: "user" });
    expect(updated.status).toBe("approved");
    expect(updated.acted_at).toBeTruthy();
    const actions = client._tables.opportunity_actions ?? [];
    expect(actions.some((a) => a.action_type === "status:approved")).toBe(true);
  });

  it("rejects an illegal transition (new -> converted)", async () => {
    const { repo } = seededRepo();
    const { opportunity } = await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "T", recommended_song_id: "S2" });
    await expect(repo.transition(opportunity.id, "converted", { kind: "user" })).rejects.toThrow(/Illegal/);
  });
});

describe("repository — outcome recording advances state and recalcs", () => {
  it("records an outcome, advances status, and returns a recalced score", async () => {
    const { client, repo } = seededRepo();
    const { opportunity } = await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "T", recommended_song_id: "S3", scoreInput: { warmth: 0.3 } });
    // Move to a state from which "responded" is legal.
    await repo.transition(opportunity.id, "approved", { kind: "user" });
    await repo.transition(opportunity.id, "contacted", { kind: "user" });

    const res = await repo.recordOutcome(opportunity.id, { outcome_type: "responded", response_received: true }, { userId: "admin", kind: "user" });
    expect(res.outcome).toBeTruthy();
    expect(typeof res.score === "number" || res.score === null).toBe(true);

    const outcomes = client._tables.opportunity_outcomes ?? [];
    expect(outcomes.length).toBe(1);
    const opp = await repo.getOpportunity(opportunity.id);
    expect(opp.status).toBe("responded");
  });
});

describe("repository — relationship aggregation", () => {
  it("aggregates recorded relationship events for an entity", async () => {
    const { repo } = seededRepo();
    await repo.recordRelationshipEvent("E1", { event_type: "contacted", source: "t", source_id: "1" });
    await repo.recordRelationshipEvent("E1", { event_type: "replied", source: "t", source_id: "2" });
    await repo.recordRelationshipEvent("E1", { event_type: "placement", source: "t", source_id: "3" });
    const summary = await repo.aggregateRelationshipForEntity("E1");
    expect(summary.events).toBe(3);
    expect(summary.replied).toBe(1);
    expect(summary.placements).toBe(1);
    expect(summary.score).toBeGreaterThan(0);
  });

  it("is idempotent on (source, source_id, event_type)", async () => {
    const { repo } = seededRepo();
    await repo.recordRelationshipEvent("E1", { event_type: "contacted", source: "t", source_id: "1" });
    await repo.recordRelationshipEvent("E1", { event_type: "contacted", source: "t", source_id: "1" });
    const summary = await repo.aggregateRelationshipForEntity("E1");
    expect(summary.events).toBe(1);
  });
});

describe("repository — stats", () => {
  it("summarizes counts by status/type and average score", async () => {
    const { repo } = seededRepo();
    await repo.createOpportunity({ entity_id: "E1", opportunity_type: "playlist_pitch", title: "A", recommended_song_id: "SA", scoreInput: { audienceFit: 1 } });
    await repo.createOpportunity({ entity_id: "E1", opportunity_type: "radio_play", title: "B", recommended_song_id: "SB", scoreInput: { audienceFit: 0 } });
    const s = await repo.stats();
    expect(s.total).toBe(2);
    expect(s.by_type.playlist_pitch).toBe(1);
    expect(s.by_type.radio_play).toBe(1);
    expect(s.avg_score).not.toBeNull();
  });
});
