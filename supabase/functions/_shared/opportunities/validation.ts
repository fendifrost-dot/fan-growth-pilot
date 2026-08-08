// Opportunity Engine — create-opportunity request-boundary validation.
//
// The opportunities-api create route accepts a JSON body straight from a client.
// Anything malformed used to reach the DB and surface as an opaque HTTP 500 (a
// NOT NULL / FK / uuid-cast / CHECK violation caught by the catch-all). That is
// safe but wrong: a malformed request is a client error, not a server fault.
//
// This module validates the FULL request boundary BEFORE any DB write and returns
// a clean, agent-readable 4xx. It is deliberately split into:
//   * validateCreateOpportunityInput  — PURE (no DB): shape, required fields, enum,
//       score-input ranges, UUID format, and clip-window ordering/nonnegativity.
//   * assertCreatableReferences (in repository.ts) — the async checks that need the
//       DB: referenced entity/track existence and end<=track duration.
// Keeping the pure half here makes every case unit-testable without a database and
// keeps the repository's internal createOpportunity (and its existing tests, which
// use synthetic non-UUID ids) untouched — this is a boundary guard, not a redesign.

import { KNOWN_OPPORTUNITY_TYPES, type GrowthOpportunityInput } from "./types.ts";
import { validateClip } from "./outcomes.ts";

/**
 * A client-safe request error. `status` is the HTTP status to return and `expose`
 * marks the message as safe to send to the client (no DB internals). The API's
 * catch-all recognizes these and returns `status` with the message verbatim,
 * while genuine unexpected errors still collapse to a generic 500.
 */
export class OpportunityRequestError extends Error {
  readonly expose = true as const;
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OpportunityRequestError";
  }
}

/** Duck-typed guard (robust across module realms) for the API catch-all. */
export function isOpportunityRequestError(e: unknown): e is OpportunityRequestError {
  return (
    !!e &&
    typeof e === "object" &&
    (e as { name?: unknown }).name === "OpportunityRequestError" &&
    typeof (e as { status?: unknown }).status === "number" &&
    (e as { expose?: unknown }).expose === true
  );
}

// Canonical hyphenated UUID (any version/variant) — matches what a client sends and
// what the Postgres `uuid` columns accept; a non-UUID would otherwise be a 22P02 cast
// error (HTTP 500) at insert time.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function bad(message: string): never {
  throw new OpportunityRequestError(400, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// scoreInput components and their documented valid ranges (see types.ts ScoreInput).
// `[lo, hi]`; hi = null means "unbounded above" (a raw size / dollar ceiling >= 0).
const SCORE_RANGES: Record<string, [number, number | null]> = {
  audienceFit: [0, 1],
  warmth: [0, 1],
  historicConversion: [0, 1],
  effort: [0, 1],
  risk: [0, 1],
  relationshipScore: [0, 100],
  audienceSize: [0, null],
  valueCeiling: [0, null],
};

function validateScoreInput(scoreInput: unknown): void {
  if (scoreInput === undefined || scoreInput === null) return;
  if (!isPlainObject(scoreInput)) bad("scoreInput must be an object");

  for (const [key, [lo, hi]] of Object.entries(SCORE_RANGES)) {
    const v = (scoreInput as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue; // absent signal — scorer uses a neutral default
    if (typeof v !== "number" || !Number.isFinite(v)) {
      bad(`scoreInput.${key} must be a finite number`);
    }
    if (v < lo || (hi !== null && v > hi)) {
      const range = hi === null ? `>= ${lo}` : `between ${lo} and ${hi}`;
      bad(`scoreInput.${key} must be ${range}`);
    }
  }

  const hasContact = (scoreInput as Record<string, unknown>).hasContact;
  if (hasContact !== undefined && hasContact !== null && typeof hasContact !== "boolean") {
    bad("scoreInput.hasContact must be a boolean");
  }
}

export interface CreateValidationContext {
  /** Track length in seconds when known — enforces recommended_end_seconds <= it. */
  trackDuration?: number | null;
}

/**
 * Validate the create-opportunity request body (everything that does NOT require a
 * DB round-trip). Throws OpportunityRequestError(400) with a clear, client-safe
 * message on the first problem; returns the body typed as GrowthOpportunityInput
 * when it is well-formed. Does NOT mutate the input — valid requests are scored and
 * stored exactly as before.
 */
export function validateCreateOpportunityInput(
  input: unknown,
  ctx: CreateValidationContext = {},
): GrowthOpportunityInput {
  if (!isPlainObject(input)) bad("Request body must be a JSON object");
  const body = input as Record<string, unknown>;

  // ---- Required fields --------------------------------------------------
  if (body.entity_id === undefined || body.entity_id === null || body.entity_id === "") {
    bad("entity_id is required");
  }
  if (!isUuid(body.entity_id)) bad("entity_id must be a valid UUID");

  if (typeof body.title !== "string" || body.title.trim() === "") {
    bad("title is required");
  }

  if (body.opportunity_type === undefined || body.opportunity_type === null || body.opportunity_type === "") {
    bad("opportunity_type is required");
  }
  if (typeof body.opportunity_type !== "string" || !(KNOWN_OPPORTUNITY_TYPES as readonly string[]).includes(body.opportunity_type)) {
    bad(`opportunity_type must be one of: ${KNOWN_OPPORTUNITY_TYPES.join(", ")}`);
  }

  // ---- Optional referenced id (format only; existence is checked with the DB) ----
  if (body.recommended_song_id !== undefined && body.recommended_song_id !== null) {
    if (!isUuid(body.recommended_song_id)) bad("recommended_song_id must be a valid UUID");
  }

  // ---- Clip window / nonnegative timestamps -----------------------------
  // The only client-supplied time values on create are the clip seconds; they must
  // be nonnegative whole seconds and, when both are present, ordered (start < end).
  // A one-sided clip is malformed (a window needs both bounds).
  const start = body.recommended_start_seconds;
  const end = body.recommended_end_seconds;
  const hasStart = start !== undefined && start !== null;
  const hasEnd = end !== undefined && end !== null;
  if (hasStart !== hasEnd) {
    bad("recommended_start_seconds and recommended_end_seconds must be provided together");
  }
  if (hasStart && hasEnd) {
    if (typeof start !== "number" || typeof end !== "number") {
      bad("recommended_start_seconds/recommended_end_seconds must be numbers");
    }
    const clip = validateClip(start as number, end as number, ctx.trackDuration ?? null);
    if (!clip.ok) bad(clip.error ?? "invalid clip window");
  }

  // ---- Score inputs -----------------------------------------------------
  validateScoreInput(body.scoreInput);

  return body as unknown as GrowthOpportunityInput;
}
