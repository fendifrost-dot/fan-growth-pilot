import { describe, it, expect } from "vitest";
import {
  validateCreateOpportunityInput,
  isOpportunityRequestError,
  OpportunityRequestError,
} from "@/lib/opportunities/validation";
import { createOpportunityRepository } from "@/lib/opportunities/repository";
import { createStubClient } from "./stubClient";

// Valid UUIDs used across the boundary tests (real requests carry uuids; the
// synthetic ids used by the repository tests are intentionally NOT uuids, which is
// exactly why UUID validation lives at the request boundary, not inside the repo).
const ENTITY_UUID = "11111111-1111-4111-8111-111111111111";
const SONG_UUID = "22222222-2222-4222-8222-222222222222";

function base(overrides: Record<string, unknown> = {}) {
  return {
    entity_id: ENTITY_UUID,
    opportunity_type: "playlist_pitch",
    title: "Pitch DFM to Deep House Vibes",
    ...overrides,
  };
}

/** Assert the callback throws a 400 OpportunityRequestError whose message matches. */
function expect400(fn: () => unknown, match: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(isOpportunityRequestError(e)).toBe(true);
    expect((e as OpportunityRequestError).status).toBe(400);
    expect((e as OpportunityRequestError).message).toMatch(match);
    return;
  }
  throw new Error("expected validation to throw a 400, but it did not");
}

describe("validateCreateOpportunityInput — required fields", () => {
  it("400 when the body is not an object", () => {
    expect400(() => validateCreateOpportunityInput("nope" as unknown), /JSON object/);
  });
  it("400 when entity_id is missing", () => {
    const { entity_id, ...rest } = base();
    void entity_id;
    expect400(() => validateCreateOpportunityInput(rest), /entity_id is required/);
  });
  it("400 when title is missing / blank", () => {
    expect400(() => validateCreateOpportunityInput(base({ title: "   " })), /title is required/);
  });
  it("400 when opportunity_type is missing", () => {
    const { opportunity_type, ...rest } = base();
    void opportunity_type;
    expect400(() => validateCreateOpportunityInput(rest), /opportunity_type is required/);
  });
});

describe("validateCreateOpportunityInput — invalid enum", () => {
  it("400 for an unknown opportunity_type", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ opportunity_type: "totally_made_up" })),
      /opportunity_type must be one of/,
    );
  });
});

describe("validateCreateOpportunityInput — malformed UUIDs", () => {
  it("400 when entity_id is not a UUID", () => {
    expect400(() => validateCreateOpportunityInput(base({ entity_id: "E1" })), /entity_id must be a valid UUID/);
  });
  it("400 when recommended_song_id is not a UUID", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ recommended_song_id: "SONG1" })),
      /recommended_song_id must be a valid UUID/,
    );
  });
});

describe("validateCreateOpportunityInput — score-input ranges", () => {
  it("400 when a 0..1 signal is out of range (warmth = 5)", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ scoreInput: { warmth: 5 } })),
      /scoreInput\.warmth must be between 0 and 1/,
    );
  });
  it("400 when relationshipScore is out of 0..100", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ scoreInput: { relationshipScore: 250 } })),
      /scoreInput\.relationshipScore must be between 0 and 100/,
    );
  });
  it("400 when a raw size is negative (audienceSize = -1)", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ scoreInput: { audienceSize: -1 } })),
      /scoreInput\.audienceSize must be >= 0/,
    );
  });
  it("400 when a numeric signal is non-finite / wrong type", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ scoreInput: { audienceFit: "high" } })),
      /scoreInput\.audienceFit must be a finite number/,
    );
  });
  it("400 when hasContact is not a boolean", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ scoreInput: { hasContact: "yes" } })),
      /scoreInput\.hasContact must be a boolean/,
    );
  });
});

describe("validateCreateOpportunityInput — clip window / nonnegative timestamps", () => {
  it("400 when start >= end (the reported live 500 case)", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ recommended_start_seconds: 90, recommended_end_seconds: 30 })),
      /end must be after start/,
    );
  });
  it("400 when start is negative", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ recommended_start_seconds: -5, recommended_end_seconds: 30 })),
      /start must be >= 0/,
    );
  });
  it("400 when only one clip bound is provided", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ recommended_start_seconds: 10 })),
      /must be provided together/,
    );
  });
  it("400 when clip seconds are not whole numbers", () => {
    expect400(
      () => validateCreateOpportunityInput(base({ recommended_start_seconds: 10.5, recommended_end_seconds: 30 })),
      /whole seconds/,
    );
  });
  it("400 when recommended_end_seconds exceeds a known track duration", () => {
    expect400(
      () =>
        validateCreateOpportunityInput(
          base({ recommended_start_seconds: 10, recommended_end_seconds: 300 }),
          { trackDuration: 200 },
        ),
      /exceeds track length/,
    );
  });
});

describe("validateCreateOpportunityInput — valid request", () => {
  it("returns the typed input unchanged for a well-formed body", () => {
    const body = base({
      recommended_song_id: SONG_UUID,
      recommended_start_seconds: 64,
      recommended_end_seconds: 88,
      scoreInput: { audienceFit: 0.9, audienceSize: 50000, warmth: 0.4, hasContact: true },
    });
    const out = validateCreateOpportunityInput(body, { trackDuration: 200 });
    expect(out.entity_id).toBe(ENTITY_UUID);
    expect(out.opportunity_type).toBe("playlist_pitch");
    expect(out.recommended_end_seconds).toBe(88);
  });
});

// ---- DB-dependent boundary checks (existence + duration) --------------------
function seededRepo() {
  const client = createStubClient({
    growth_entities: [{ id: ENTITY_UUID, entity_type: "playlist", name: "Deep House Vibes" }],
    tracks: [{ id: SONG_UUID, name: "Designed For Me", status: "active", duration_seconds: 200 }],
  });
  return { client, repo: createOpportunityRepository(client as never) };
}

describe("assertCreatableReferences — referenced rows must exist", () => {
  it("404 when the entity does not exist", async () => {
    const { repo } = seededRepo();
    const input = validateCreateOpportunityInput(
      base({ entity_id: "33333333-3333-4333-8333-333333333333" }),
    );
    await expect(repo.assertCreatableReferences(input)).rejects.toMatchObject({ status: 404 });
  });

  it("404 when the recommended track does not exist", async () => {
    const { repo } = seededRepo();
    const input = validateCreateOpportunityInput(
      base({ recommended_song_id: "44444444-4444-4444-8444-444444444444" }),
    );
    await expect(repo.assertCreatableReferences(input)).rejects.toMatchObject({ status: 404 });
  });

  it("400 when the clip exceeds the referenced track's real duration", async () => {
    const { repo } = seededRepo();
    // Pure validation passes (no trackDuration given, and 10 < 999); the over-length
    // clip is only catchable against the DB-known duration (200s), which is exactly
    // what assertCreatableReferences enforces.
    const input = validateCreateOpportunityInput(
      base({ recommended_song_id: SONG_UUID, recommended_start_seconds: 10, recommended_end_seconds: 999 }),
    );
    await expect(repo.assertCreatableReferences(input)).rejects.toMatchObject({ status: 400 });
  });

  it("resolves for valid references (entity + track + fitting clip)", async () => {
    const { repo } = seededRepo();
    const input = validateCreateOpportunityInput(
      base({ recommended_song_id: SONG_UUID, recommended_start_seconds: 64, recommended_end_seconds: 88 }),
      { trackDuration: 200 },
    );
    await expect(repo.assertCreatableReferences(input)).resolves.toBeUndefined();
  });
});

// ---- End-to-end boundary: valid request still creates successfully ----------
describe("create-opportunity boundary — valid request still succeeds", () => {
  it("a fully-validated request scores and creates as before", async () => {
    const { repo } = seededRepo();
    const input = validateCreateOpportunityInput(
      base({
        recommended_song_id: SONG_UUID,
        recommended_start_seconds: 64,
        recommended_end_seconds: 88,
        scoreInput: { audienceFit: 0.9, warmth: 0.5 },
      }),
      { trackDuration: 200 },
    );
    await repo.assertCreatableReferences(input);
    const result = await repo.createOpportunity(input);
    expect(result.created).toBe(true);
    expect(result.opportunity.opportunity_score).toBeGreaterThan(0);
    expect(result.opportunity.status).toBe("new");
  });
});
