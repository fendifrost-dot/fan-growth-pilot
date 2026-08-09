// Opportunity Engine — Conversation / Interaction request-boundary validation.
//
// The daily growth operation needs a small, authenticated surface over the
// EXISTING growth_conversations + growth_interactions tables (migration
// 20260801000000 §8.5b/§8.5c) so it can: find-or-create a conversation, record a
// PROPOSED interaction, and advance that interaction's status after a human acts.
//
// This module is the PURE (no-DB) half — shape / enum / UUID checks that turn a
// malformed request into a clean 4xx BEFORE any write (mirrors validation.ts for
// create-opportunity). The DB-dependent half (referenced entity/conversation must
// exist, status-transition legality against the stored row) lives in repository.ts.
//
// Runtime-agnostic: no Deno globals, no browser client — importable by the Deno
// Edge Function, Vite, and vitest alike (single source of truth).

import { isUuid, OpportunityRequestError } from "./validation.ts";

// ---- Domain vocabularies (mirror the DB CHECK constraints) -----------------

// growth_interactions.interaction_type CHECK (the channel of a touch).
export const INTERACTION_TYPES = [
  "email",
  "instagram_dm",
  "telegram",
  "web_form",
  "reddit",
  "youtube_comment",
  "playlist_submission",
  "phone",
  "in_person",
  "event",
  "note",
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

// growth_interactions.direction CHECK.
export const INTERACTION_DIRECTIONS = ["inbound", "outbound", "system"] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

// growth_interactions.match_status CHECK.
export const INTERACTION_MATCH_STATUSES = [
  "matched",
  "partial",
  "unknown",
  "needs_review",
  "rejected",
] as const;
export type InteractionMatchStatus = (typeof INTERACTION_MATCH_STATUSES)[number];

// growth_conversations.status CHECK.
export const CONVERSATION_STATUSES = [
  "open",
  "awaiting_reply",
  "replied",
  "stalled",
  "closed",
] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

// The proposed -> sent -> responded lifecycle of a SINGLE outbound touch. The
// growth_interactions table has no first-class `status` column (it is channel-
// polymorphic, not lifecycle-shaped), so this lives in the interaction's `payload`
// jsonb under `payload.status` — an existing column, no schema change. The API
// reads/writes it through the repository; the transition guard below keeps it
// monotone so a human action can only advance a touch, never silently rewind it.
export const INTERACTION_STATUSES = [
  "proposed",
  "sent",
  "responded",
  "no_response",
  "failed",
  "skipped",
  "superseded",
] as const;
export type InteractionStatus = (typeof INTERACTION_STATUSES)[number];

// Legal forward moves. Empty array = terminal.
export const INTERACTION_STATUS_TRANSITIONS: Record<InteractionStatus, InteractionStatus[]> = {
  proposed: ["sent", "skipped", "superseded", "failed"],
  sent: ["responded", "no_response", "failed"],
  no_response: ["responded", "superseded"],
  failed: ["sent", "skipped"],
  responded: [],
  skipped: [],
  superseded: [],
};

export const DEFAULT_INTERACTION_STATUS: InteractionStatus = "proposed";

// ---- Typed inputs ----------------------------------------------------------

export interface ConversationInput {
  entity_id: string;
  opportunity_id?: string | null;
  subject?: string | null;
  status?: ConversationStatus;
}

/**
 * A UNIQUE per-target Smart Link, recorded ON the interaction (spec §10). Stored
 * in payload.smart_link — NO schema change to the Lovable-managed smart_links /
 * link_analytics tables. This is the association half of the attribution path:
 * a later click resolves back to this opportunity/interaction by a reverse lookup
 * (link_analytics.link_id -> smart_links.short_code/slug -> this ref -> opportunity_id),
 * so no column is needed on smart_links or link_analytics. At least one of
 * slug / short_code must be present (that is what a click carries back).
 */
export interface SmartLinkRef {
  slug?: string | null;
  short_code?: string | null;
  url?: string | null;
}

export interface InteractionInput {
  conversation_id?: string | null;
  entity_id?: string | null;
  opportunity_id?: string | null;
  interaction_type: InteractionType;
  direction: InteractionDirection;
  status: InteractionStatus;
  match_status: InteractionMatchStatus;
  subject?: string | null;
  /** The proposed message body (stored in growth_interactions.body_preview). */
  body_preview?: string | null;
  /** Provider thread id — a DETAIL, not the conversation's identity. */
  external_thread_ref?: string | null;
  external_message_id?: string | null;
  in_reply_to?: string | null;
  occurred_at?: string | null;
  /** Evidence / source provenance, folded into payload alongside status. */
  evidence?: unknown;
  source?: string | null;
  /** The unique per-target Smart Link for this touch (payload.smart_link). */
  smart_link?: SmartLinkRef | null;
  payload?: Record<string, unknown>;
}

export interface InteractionStatusUpdate {
  status: InteractionStatus;
  match_status?: InteractionMatchStatus;
  /** Set the provider ids when a proposed touch is actually sent. */
  external_message_id?: string | null;
  external_thread_ref?: string | null;
  occurred_at?: string | null;
  body_preview?: string | null;
  /** Attach/replace the per-target Smart Link when it is minted at send time. */
  smart_link?: SmartLinkRef | null;
}

// ---- Helpers ---------------------------------------------------------------

function bad(message: string): never {
  throw new OpportunityRequestError(400, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalUuid(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isUuid(v)) bad(`${field} must be a valid UUID`);
  return v as string;
}

function optionalString(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") bad(`${field} must be a string`);
  return v as string;
}

function optionalIsoTimestamp(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    bad(`${field} must be an ISO-8601 timestamp`);
  }
  return v as string;
}

/** Validate an optional per-target Smart Link ref. Requires at least one of
 *  slug / short_code (the identifier a click carries back). Returns null when
 *  absent so callers can spread it unconditionally. */
function validateSmartLinkRef(v: unknown): SmartLinkRef | null {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) bad("smart_link must be an object");
  const slug = optionalString(v.slug, "smart_link.slug");
  const short_code = optionalString(v.short_code, "smart_link.short_code");
  const url = optionalString(v.url, "smart_link.url");
  if (!slug && !short_code) bad("smart_link requires a slug or short_code");
  return { slug, short_code, url };
}

function inEnum<T extends readonly string[]>(
  v: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    bad(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return v as T[number];
}

// ---- Validators ------------------------------------------------------------

/** find-or-create-conversation body. entity_id is the only required field. */
export function validateConversationInput(input: unknown): ConversationInput {
  if (!isPlainObject(input)) bad("Request body must be a JSON object");
  const body = input;

  if (body.entity_id === undefined || body.entity_id === null || body.entity_id === "") {
    bad("entity_id is required");
  }
  if (!isUuid(body.entity_id)) bad("entity_id must be a valid UUID");

  const out: ConversationInput = {
    entity_id: body.entity_id as string,
    opportunity_id: optionalUuid(body.opportunity_id, "opportunity_id"),
    subject: optionalString(body.subject, "subject"),
  };
  if (body.status !== undefined && body.status !== null) {
    out.status = inEnum(body.status, CONVERSATION_STATUSES, "status");
  }
  return out;
}

/** record-interaction body. interaction_type is required; direction/status/
 *  match_status default to the schema defaults; every id is format-checked. */
export function validateInteractionInput(input: unknown): InteractionInput {
  if (!isPlainObject(input)) bad("Request body must be a JSON object");
  const body = input;

  const interaction_type = inEnum(body.interaction_type, INTERACTION_TYPES, "interaction_type");

  const direction = body.direction == null
    ? "outbound"
    : inEnum(body.direction, INTERACTION_DIRECTIONS, "direction");

  const status = body.status == null
    ? DEFAULT_INTERACTION_STATUS
    : inEnum(body.status, INTERACTION_STATUSES, "status");

  const match_status = body.match_status == null
    ? "unknown"
    : inEnum(body.match_status, INTERACTION_MATCH_STATUSES, "match_status");

  if (body.payload !== undefined && body.payload !== null && !isPlainObject(body.payload)) {
    bad("payload must be an object");
  }

  return {
    conversation_id: optionalUuid(body.conversation_id, "conversation_id"),
    entity_id: optionalUuid(body.entity_id, "entity_id"),
    opportunity_id: optionalUuid(body.opportunity_id, "opportunity_id"),
    interaction_type,
    direction,
    status,
    match_status,
    subject: optionalString(body.subject, "subject"),
    // Accept either `body_preview` or `message` as the proposed message body.
    body_preview: optionalString(
      body.body_preview ?? body.message ?? null,
      "body_preview",
    ),
    external_thread_ref: optionalString(body.external_thread_ref, "external_thread_ref"),
    external_message_id: optionalString(body.external_message_id, "external_message_id"),
    in_reply_to: optionalString(body.in_reply_to, "in_reply_to"),
    occurred_at: optionalIsoTimestamp(body.occurred_at, "occurred_at"),
    evidence: body.evidence ?? undefined,
    source: optionalString(body.source, "source"),
    smart_link: validateSmartLinkRef(body.smart_link),
    payload: isPlainObject(body.payload) ? body.payload : undefined,
  };
}

/** update-interaction-status body. status (the target) is required. */
export function validateInteractionStatusUpdate(input: unknown): InteractionStatusUpdate {
  if (!isPlainObject(input)) bad("Request body must be a JSON object");
  const body = input;

  if (body.status === undefined || body.status === null || body.status === "") {
    bad("status is required");
  }
  const status = inEnum(body.status, INTERACTION_STATUSES, "status");

  const out: InteractionStatusUpdate = { status };
  if (body.match_status !== undefined && body.match_status !== null) {
    out.match_status = inEnum(body.match_status, INTERACTION_MATCH_STATUSES, "match_status");
  }
  out.external_message_id = optionalString(body.external_message_id, "external_message_id");
  out.external_thread_ref = optionalString(body.external_thread_ref, "external_thread_ref");
  out.occurred_at = optionalIsoTimestamp(body.occurred_at, "occurred_at");
  out.body_preview = optionalString(body.body_preview, "body_preview");
  out.smart_link = validateSmartLinkRef(body.smart_link);
  return out;
}

/**
 * Legality of a status move, checked against the stored interaction. Throws an
 * exposable 409 so the API returns a clean conflict (mirrors the opportunity
 * illegal-transition handling) rather than silently rewinding a touch.
 */
export function assertInteractionStatusTransition(
  from: InteractionStatus,
  to: InteractionStatus,
): void {
  const allowed = INTERACTION_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new OpportunityRequestError(
      409,
      `Illegal interaction status transition: ${from} -> ${to}`,
    );
  }
}
