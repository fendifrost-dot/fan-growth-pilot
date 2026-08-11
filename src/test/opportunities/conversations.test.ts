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
      { id: "ORG2", entity_type: "organization", name: "Toolroom" },
    ],
    growth_opportunities: [
      { id: "OPP1", entity_id: "ORG1", opportunity_type: "playlist_pitch", title: "Pitch DFM", status: "new" },
      { id: "OPP2", entity_id: "ORG2", opportunity_type: "playlist_pitch", title: "Pitch DFM #2", status: "new" },
    ],
  });
  return { client, repo: createOpportunityRepository(client as never) };
}

// Valid UUIDs for the request-boundary (validator) tests — a proposed interaction
// must carry conversation + opportunity + contact, all UUID-format.
const CONV_UUID = "33333333-3333-4333-8333-333333333333";
const ENT_UUID = "44444444-4444-4444-8444-444444444444";
const OPP_UUID = "55555555-5555-4555-8555-555555555555";
function proposedBody(overrides: Record<string, unknown> = {}) {
  return {
    interaction_type: "email",
    conversation_id: CONV_UUID,
    entity_id: ENT_UUID,
    opportunity_id: OPP_UUID,
    idempotency_key: "cowork-op-key",
    ...overrides,
  };
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

describe("conversations — entity/opportunity consistency AT CREATION", () => {
  it("409 when the conversation entity and the opportunity belong to different orgs", async () => {
    const { client, repo } = seeded();
    // entity = ORG1, but OPP2 belongs to ORG2 — a cross-wired thread.
    await expectStatus(
      () => repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP2" }),
      409,
      /does not belong to the opportunity's organization/,
    );
    // …and nothing was created.
    expect(client._tables.growth_conversations?.length ?? 0).toBe(0);
  });

  it("allows a conversation on a child contact for an org-level opportunity (same hierarchy)", async () => {
    const { repo } = seeded();
    // entity = C1 (child of ORG1), opportunity OPP1 belongs to ORG1 → consistent.
    const res = await repo.findOrCreateConversation({ entity_id: "C1", opportunity_id: "OPP1" });
    expect(res.created).toBe(true);
    expect(res.conversation.entity_id).toBe("C1");
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

describe("interactions — provider idempotency (not duplicated)", () => {
  it("a re-sent touch with the same (interaction_type, external_message_id) is deduped, not duplicated", async () => {
    const { client, repo } = seeded();
    const first = await repo.recordInteraction({
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "sent",
      match_status: "unknown",
      external_message_id: "gmail-msg-idem-1",
    });
    expect(first.created).toBe(true);

    const again = await repo.recordInteraction({
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "sent",
      match_status: "unknown",
      external_message_id: "gmail-msg-idem-1",
    });
    expect(again.created).toBe(false);
    expect(again.deduped).toBe(true);
    expect(again.interaction.id).toBe(first.interaction.id);
    expect(client._tables.growth_interactions.length).toBe(1);
  });
});

describe("interactions — proposal-stage idempotency (no provider id yet)", () => {
  it("the same proposed touch submitted twice with one idempotency_key yields ONE row and 200 replay", async () => {
    const { client, repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    const proposal = {
      conversation_id: conv.id,
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email" as const,
      direction: "outbound" as const,
      status: "proposed" as const,
      match_status: "unknown" as const,
      idempotency_key: "cowork-op-2026-08-09-001",
    };

    const a = await repo.recordInteraction(proposal);
    expect(a.created).toBe(true); // 201

    const b = await repo.recordInteraction(proposal);
    expect(b.created).toBe(false); // 200 replay
    expect(b.deduped).toBe(true);
    expect(b.interaction.id).toBe(a.interaction.id);
    expect(client._tables.growth_interactions.length).toBe(1);
  });

  it("two PARALLEL submits of the same keyed proposal still yield exactly one row", async () => {
    const { client, repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    const proposal = {
      conversation_id: conv.id, entity_id: "C1", opportunity_id: "OPP1",
      interaction_type: "email" as const, direction: "outbound" as const,
      status: "proposed" as const, match_status: "unknown" as const,
      idempotency_key: "cowork-op-parallel",
    };
    const [a, b] = await Promise.all([repo.recordInteraction(proposal), repo.recordInteraction(proposal)]);
    expect(a.interaction.id).toBe(b.interaction.id);
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
    expect(client._tables.growth_interactions.length).toBe(1);
  });
});

describe("interactions — UNIQUE per-target Smart Link association + attributable click", () => {
  it("records a per-target link on the interaction and resolves a click back to its opportunity", async () => {
    const { repo } = seeded();
    const { interaction } = await repo.recordInteraction({
      entity_id: "C1",
      opportunity_id: "OPP1",
      interaction_type: "email",
      direction: "outbound",
      status: "proposed",
      match_status: "unknown",
      smart_link: { slug: "anjuna-dfm", short_code: "aXb12", url: "https://smrt.link/aXb12" },
    });
    expect(interaction.payload.smart_link.short_code).toBe("aXb12");

    // A click comes back carrying the link's short_code -> resolves to the exact
    // interaction + opportunity (the §10 reverse-lookup, no smart_links change).
    const byClick = await repo.findInteractionsBySmartLink("aXb12");
    expect(byClick.rows.length).toBe(1);
    expect(byClick.rows[0].id).toBe(interaction.id);
    expect(byClick.rows[0].opportunity_id).toBe("OPP1");

    // Slug also resolves.
    const bySlug = await repo.findInteractionsBySmartLink("anjuna-dfm");
    expect(bySlug.rows[0].opportunity_id).toBe("OPP1");
  });

  it("keeps per-target links UNIQUE — each opportunity's link resolves only to its own", async () => {
    const { repo } = seeded();
    await repo.recordInteraction({
      entity_id: "C1", opportunity_id: "OPP1", interaction_type: "email",
      direction: "outbound", status: "proposed", match_status: "unknown",
      smart_link: { short_code: "TARGET1" },
    });
    await repo.recordInteraction({
      entity_id: "ORG2", opportunity_id: "OPP2", interaction_type: "email",
      direction: "outbound", status: "proposed", match_status: "unknown",
      smart_link: { short_code: "TARGET2" },
    });

    const r1 = await repo.findInteractionsBySmartLink("TARGET1");
    const r2 = await repo.findInteractionsBySmartLink("TARGET2");
    expect(r1.rows.length).toBe(1);
    expect(r2.rows.length).toBe(1);
    expect(r1.rows[0].opportunity_id).toBe("OPP1");
    expect(r2.rows[0].opportunity_id).toBe("OPP2");
  });

  it("can attach the per-target link at send time via a status advance", async () => {
    const { repo } = seeded();
    const { interaction } = await repo.recordInteraction({
      entity_id: "C1", opportunity_id: "OPP1", interaction_type: "email",
      direction: "outbound", status: "proposed", match_status: "unknown",
    });
    const sent = await repo.updateInteractionStatus(interaction.id, {
      status: "sent",
      external_message_id: "gmail-msg-2",
      smart_link: { short_code: "LATE1" },
    });
    expect(sent.payload.smart_link.short_code).toBe("LATE1");
    const resolved = await repo.findInteractionsBySmartLink("LATE1");
    expect(resolved.rows[0].id).toBe(interaction.id);
  });
});

describe("interactions — relational consistency (touch within its conversation)", () => {
  it("409 when the interaction's entity/contact does not belong to the conversation's org", async () => {
    const { repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    // ORG2 is a different organization — not ORG1 and not a child of ORG1.
    await expectStatus(
      () => repo.recordInteraction({
        conversation_id: conv.id, entity_id: "ORG2", opportunity_id: "OPP1",
        interaction_type: "email", direction: "outbound", status: "proposed", match_status: "unknown",
      }),
      409,
      /does not belong to the conversation's organization/,
    );
  });

  it("409 when the interaction's opportunity disagrees with its conversation", async () => {
    const { repo } = seeded();
    const conv = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    await expectStatus(
      () => repo.recordInteraction({
        conversation_id: conv.id, entity_id: "C1", opportunity_id: "OPP2",
        interaction_type: "email", direction: "outbound", status: "proposed", match_status: "unknown",
      }),
      409,
      /opportunity does not match its conversation/,
    );
  });
});

describe("conversations — concurrency-safe find-or-create", () => {
  it("two parallel find-or-creates for the same target yield ONE row and return the winner", async () => {
    const { client, repo } = seeded();
    const [a, b] = await Promise.all([
      repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" }),
      repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" }),
    ]);
    // Exactly one insert won; the loser caught the unique violation and returned it.
    expect(a.conversation.id).toBe(b.conversation.id);
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
    expect(client._tables.growth_conversations.length).toBe(1);
  });
});

describe("interactions — per-target Smart Link reuse rejected", () => {
  it("409 when a slug/short_code is already associated with another interaction", async () => {
    const { repo } = seeded();
    const conv1 = (await repo.findOrCreateConversation({ entity_id: "ORG1", opportunity_id: "OPP1" })).conversation;
    await repo.recordInteraction({
      conversation_id: conv1.id, entity_id: "C1", opportunity_id: "OPP1",
      interaction_type: "email", direction: "outbound", status: "proposed", match_status: "unknown",
      smart_link: { short_code: "SHARED1" },
    });
    const conv2 = (await repo.findOrCreateConversation({ entity_id: "ORG2", opportunity_id: "OPP2" })).conversation;
    await expectStatus(
      () => repo.recordInteraction({
        conversation_id: conv2.id, entity_id: "ORG2", opportunity_id: "OPP2",
        interaction_type: "email", direction: "outbound", status: "proposed", match_status: "unknown",
        smart_link: { short_code: "SHARED1" },
      }),
      409,
      /already associated with another interaction/,
    );
  });
});

describe("interactions — 201 create vs 200 replay signal", () => {
  it("first write is a create (created:true -> 201); a provider replay is created:false -> 200", async () => {
    const { repo } = seeded();
    const first = await repo.recordInteraction({
      entity_id: "C1", opportunity_id: "OPP1", interaction_type: "email",
      direction: "outbound", status: "sent", match_status: "unknown", external_message_id: "route-idem-1",
    });
    expect(first.created).toBe(true); // route maps -> 201

    const replay = await repo.recordInteraction({
      entity_id: "C1", opportunity_id: "OPP1", interaction_type: "email",
      direction: "outbound", status: "sent", match_status: "unknown", external_message_id: "route-idem-1",
    });
    expect(replay.created).toBe(false); // route maps -> 200
    expect(replay.deduped).toBe(true);
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
    const parsed = validateInteractionInput(proposedBody());
    expect(parsed.direction).toBe("outbound");
    expect(parsed.status).toBe("proposed");
    expect(parsed.match_status).toBe("unknown");
  });

  it("accepts `message` as an alias for the proposed body", () => {
    const parsed = validateInteractionInput(proposedBody({ message: "hello there" }));
    expect(parsed.body_preview).toBe("hello there");
  });

  it("400 on a smart_link with neither slug nor short_code", () => {
    expect(() => validateInteractionInput(proposedBody({ smart_link: { url: "https://x/y" } })))
      .toThrowError(/smart_link requires a slug or short_code/);
  });

  it("accepts a well-formed smart_link ref", () => {
    const parsed = validateInteractionInput(proposedBody({ smart_link: { short_code: "aXb12" } }));
    expect(parsed.smart_link?.short_code).toBe("aXb12");
  });
});

describe("interactions — orphan PROPOSED touch rejected (meaningful linkage required)", () => {
  it("400 when a proposed interaction has no conversation_id", () => {
    expect(() => validateInteractionInput({ interaction_type: "email", entity_id: ENT_UUID, opportunity_id: OPP_UUID }))
      .toThrowError(/proposed interaction requires conversation_id/);
  });

  it("400 when a proposed interaction has no opportunity_id", () => {
    expect(() => validateInteractionInput({ interaction_type: "email", conversation_id: CONV_UUID, entity_id: ENT_UUID }))
      .toThrowError(/proposed interaction requires opportunity_id/);
  });

  it("400 when a proposed interaction has no entity_id (contact)", () => {
    expect(() => validateInteractionInput({ interaction_type: "email", conversation_id: CONV_UUID, opportunity_id: OPP_UUID, idempotency_key: "k" }))
      .toThrowError(/proposed interaction requires entity_id/);
  });

  it("400 when a proposed interaction has no idempotency_key", () => {
    expect(() => validateInteractionInput({ interaction_type: "email", conversation_id: CONV_UUID, opportunity_id: OPP_UUID, entity_id: ENT_UUID }))
      .toThrowError(/proposed interaction requires idempotency_key/);
  });

  it("a NON-proposed touch (e.g. an inbound reply) is exempt from the linkage rule", () => {
    const parsed = validateInteractionInput({ interaction_type: "email", direction: "inbound", status: "responded" });
    expect(parsed.status).toBe("responded");
    expect(parsed.conversation_id).toBeNull();
  });
});
