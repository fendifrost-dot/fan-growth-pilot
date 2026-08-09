import { describe, it, expect } from "vitest";
import { createOpportunityRepository } from "@/lib/opportunities/repository";
import { classifyRoute, decideAccess } from "@/lib/opportunities/access";
import type { OppActor } from "@/lib/opportunities/access";
import {
  assertInteractionStatusTransition,
  validateConversationInput,
  validateInteractionInput,
  validateInteractionStatusUpdate,
} from "@/lib/opportunities/conversations";
import { isOpportunityRequestError, type OpportunityRequestError } from "@/lib/opportunities/validation";
import { createStubClient } from "./stubClient";

// The daily growth op works over the EXISTING growth_conversations +
// growth_interactions tables through the same repository the Edge Function uses.
// Synthetic (non-UUID) ids are fine here: UUID-format validation lives at the
// request boundary (the validate* functions), not inside the repository — exactly
// mirroring the create-opportunity tests.
function seeded() {
  const client = createStubClient({
    growth_entities: [
      { id: "ORG1", entity_type: "organization", name: "Anjuna" },
      { id: "C1", entity_type: "contact", name: "demos@anjunabeats.com", parent_entity_id: "ORG1" },
    ],
    growth_opportunities: [
      { id: "OPP1", entity_id: "ORG1", opportunity_type: "playlist_pitch", title: "Pitch DFM", status: "new" },
    ],
  });
  return { client, repo: createOpportunityRepository(client as never) };
}

/** Assert the callback throws an OpportunityRequestError with the given status + message. */
async function expectStatus(fn: () => unknown | Promise<unknown>, status: number, match: RegExp) {
  try {
    await fn();
  } catch (e) {
    expect(isOpportunityRequestError(e)).toBe(true);
    expect((e as OpportunityRequestError).status).toBe(status);
    expect((e as OpportunityRequestError).message).toMatch(match);
    return;
  }
  throw new Error(`expected a ${status} to be thrown, but nothing was`);
}

describe("conversations — find-or-create (idempotent business thread)", () => {
  it("creates a conversation for an (entity, opportunity) pair, then reuses it", async () => {
    const { client, repo } = seeded();
    const a = await repo.findOrCreateConversation({
      entity_id: "ORG1",
      opportunity_id: "OPP1",
      subject: "Placement on Anjunadeep",
    });
    expect(a.created).toBe(true);
    expect(a.conversation.entity_id).toBe("ORG1");
    expect(a.conversation.opportunity_id).toBe("OPP1");
    expect(a.conversation.status).toBe("open");

    const b = await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" });
    expect(b.created).toBe(false);
    expect(b.conversation.id).toBe(a.conversation.id);
    expect(client._tables.growth_conversations.length).toBe(1);
  });

  it("404s when the conversation's entity does not exist", async () => {
    const { repo } = seeded();
    await expectStatus(
      () => repo.findOrCreateConversation({ entity_id: "GHOST" }),
      404,
      /entity_id does not reference/,
    );
  });
});

describe("interactions — record a PROPOSED touch", () => {
  it("records a proposed interaction with channel, direction, provider refs, status + evidence", async () => {
    const { client, repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;

    const res = await repo.recordInteraction({
      conversation_id: conv.id,
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "proposed",
      match_status: "unknown",
      subject: "Anjunadeep consideration",
      body_preview: "Hi — sharing a track for Anjunadeep…",
      external_thread_ref: "gmail-thread-abc",
      source: "opportunity_engine",
      evidence: { discovered_via: "spotify_editorial" },
    });

    expect(res.created).toBe(true);
    const it = res.interaction;
    expect(it.interaction_type).toBe("email");
    expect(it.direction).toBe("outbound");
    expect(it.body_preview).toContain("Anjunadeep");
    expect(it.external_thread_ref).toBe("gmail-thread-abc");
    // lifecycle status + evidence/source are folded into payload (no schema change).
    expect(it.payload.status).toBe("proposed");
    expect(it.payload.source).toBe("opportunity_engine");
    expect(it.payload.evidence.discovered_via).toBe("spotify_editorial");
    expect(client._tables.growth_interactions.length).toBe(1);

    // the conversation's last_interaction_at is bumped to reflect the touch.
    const bumped = client._tables.growth_conversations.find((c) => c.id === conv.id);
    expect(bumped?.last_interaction_at).toBeTruthy();
  });
});

describe("interactions — association to opportunity + entity/contact", () => {
  it("stores and can retrieve an interaction by its opportunity association", async () => {
    const { repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    const { interaction } = await repo.recordInteraction({
      conversation_id: conv.id,
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "proposed",
      match_status: "unknown",
    });

    expect(interaction.conversation_id).toBe(conv.id);
    expect(interaction.opportunity_id).toBe("OPP1");
    expect(interaction.entity_id).toBe("C1");

    const byOpp = await repo.listInteractions({ opportunity_id: "OPP1" });
    expect(byOpp.rows.length).toBe(1);
    expect(byOpp.rows[0].id).toBe(interaction.id);

    const byConv = await repo.listInteractions({ conversation_id: conv.id });
    expect(byConv.rows[0].id).toBe(interaction.id);
  });
});

describe("interactions — status lifecycle after a human action", () => {
  it("advances a proposed touch to sent, then responded, capturing provider ids + match_status", async () => {
    const { repo } = seeded();
    const { interaction } = await repo.recordInteraction({
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "proposed",
      match_status: "unknown",
    });

    const sent = await repo.updateInteractionStatus(interaction.id, {
      status: "sent",
      external_message_id: "gmail-msg-1",
    });
    expect(sent.payload.status).toBe("sent");
    expect(sent.external_message_id).toBe("gmail-msg-1");

    const responded = await repo.updateInteractionStatus(interaction.id, {
      status: "responded",
      match_status: "matched",
    });
    expect(responded.payload.status).toBe("responded");
    expect(responded.match_status).toBe("matched");
  });

  it("rejects an illegal transition (proposed -> responded) with a clean 409", async () => {
    const { repo } = seeded();
    const { interaction } = await repo.recordInteraction({
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "proposed",
      match_status: "unknown",
    });
    await expectStatus(
      () => repo.updateInteractionStatus(interaction.id, { status: "responded" }),
      409,
      /Illegal interaction status transition/,
    );
  });

  it("guards transitions purely: sent->responded allowed, proposed->responded blocked", () => {
    expect(() => assertInteractionStatusTransition("sent", "responded")).not.toThrow();
    expect(() => assertInteractionStatusTransition("proposed", "responded")).toThrow(
      /Illegal interaction status transition/,
    );
  });
});

describe("conversation/interaction API — admin gate (RLS-sensitive)", () => {
  const user: OppActor = { kind: "user", userId: "u1", isAdmin: false };
  const admin: OppActor = { kind: "user", userId: "a1", isAdmin: true };

  it("POST/PATCH on conversations + interactions require admin — a plain user is 403", () => {
    expect(decideAccess(classifyRoute("POST", ["conversations"]), user)).toMatchObject({ ok: false, status: 403 });
    expect(decideAccess(classifyRoute("POST", ["interactions"]), user)).toMatchObject({ ok: false, status: 403 });
    expect(decideAccess(classifyRoute("PATCH", ["interactions", "id"]), user)).toMatchObject({ ok: false, status: 403 });
    expect(decideAccess(classifyRoute("POST", ["interactions"]), admin)).toMatchObject({ ok: true });
  });

  it("GET on interactions is readable by any signed-in user", () => {
    expect(decideAccess(classifyRoute("GET", ["interactions"]), user)).toMatchObject({ ok: true });
  });
});

describe("conversation/interaction validation — clean 400s", () => {
  it("400 when a conversation body has no entity_id", () => {
    expect(() => validateConversationInput({})).toThrowError(/entity_id is required/);
  });

  it("400 on an unknown interaction_type", () => {
    expect(() => validateInteractionInput({ interaction_type: "carrier_pigeon" })).toThrowError(
      /interaction_type must be one of/,
    );
  });

  it("400 on a non-UUID opportunity_id", () => {
    expect(() => validateInteractionInput({ interaction_type: "email", opportunity_id: "not-a-uuid" })).toThrowError(
      /opportunity_id must be a valid UUID/,
    );
  });

  it("400 when a status update carries no target status", () => {
    expect(() => validateInteractionStatusUpdate({})).toThrowError(/status is required/);
  });

  it("defaults direction/status/match_status to the schema defaults when omitted", () => {
    const parsed = validateInteractionInput({ interaction_type: "email" });
    expect(parsed.direction).toBe("outbound");
    expect(parsed.status).toBe("proposed");
    expect(parsed.match_status).toBe("unknown");
  });

  it("accepts `message` as an alias for the proposed body", () => {
    const parsed = validateInteractionInput({ interaction_type: "email", message: "hello there" });
    expect(parsed.body_preview).toBe("hello there");
  });
});
