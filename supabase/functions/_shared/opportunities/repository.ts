// Opportunity Engine — repository (data access + orchestration).
//
// Runtime-agnostic: takes an INJECTED Supabase-like client (structural interface
// below) so the SAME code runs under the Deno Edge Function (service-role client)
// and under vitest (in-memory stub). It never imports a concrete client, which is
// what keeps the module importable by Vite/Node/Deno alike.
//
// All deterministic logic (scoring, dedupe, transitions, aggregation) is delegated
// to the sibling pure modules — this file only wires them to storage.

import type {
  GrowthEntityInput,
  GrowthOpportunityInput,
  OpportunityStatus,
  OutcomeRow,
  RelationshipEvent,
  ScoreWeights,
} from "./types.ts";
import { compositeScore, computeScoreComponents, DEFAULT_WEIGHTS } from "./scoring.ts";
import { entityDedupeKey, normalizeExternalId, normalizePlatform, opportunityDedupeKey } from "./normalization.ts";
import { aggregateRelationship, EVENT_WEIGHTS } from "./relationship-memory.ts";
import { assertTransition, deriveOutcomeState, outcomeScoreSignals, validateClip } from "./outcomes.ts";
import { generateMessage, recommendAction } from "./messaging.ts";
import { OpportunityRequestError } from "./validation.ts";
import {
  assertInteractionStatusTransition,
  type ConversationInput,
  DEFAULT_INTERACTION_STATUS,
  type InteractionInput,
  type InteractionStatus,
  type InteractionStatusUpdate,
} from "./conversations.ts";

export const SCORE_VERSION = "det-v1";

/** Which relationship event an opportunity outcome implies (drives memory). */
const OUTCOME_TO_REL_EVENT: Record<string, string> = {
  contacted: "contacted",
  responded: "replied",
  positive: "positive_reply",
  negative: "negative_reply",
  converted: "converted",
  closed_won: "converted",
};

// Minimal structural surface of supabase-js we actually use. `any` on the builder
// keeps the module portable (no URL import of the concrete PostgREST types).
export interface SupabaseLike {
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc?(fn: string, args?: Record<string, unknown>): any;
}

export interface ListFilters {
  status?: string | string[];
  opportunity_type?: string;
  source_platform?: string;
  entity_type?: string;
  recommended_song_id?: string;
  min_score?: number;
  max_risk?: number;
  min_relationship?: number;
  discovered_after?: string;
  discovered_before?: string;
  search?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  order?: "score" | "recent";
}

export interface Actor {
  userId?: string | null;
  kind?: "user" | "scheduler" | "service";
}

export interface ConversationFilters {
  entity_id?: string;
  opportunity_id?: string;
  status?: string;
}

export interface InteractionFilters {
  conversation_id?: string;
  opportunity_id?: string;
  entity_id?: string;
}

const isUniqueViolation = (err: unknown): boolean =>
  !!err && typeof err === "object" && (err as { code?: string }).code === "23505";

export function createOpportunityRepository(db: SupabaseLike) {
  // ---- Entities ----------------------------------------------------------
  async function findOrCreateEntity(input: GrowthEntityInput) {
    const platform = normalizePlatform(input.platform);
    const extId = normalizeExternalId(input.platform_external_id);

    // Strong identity: (platform, external_id).
    if (platform && extId) {
      const { data: existing } = await db
        .from("growth_entities")
        .select("*")
        .ilike("platform", input.platform ?? "")
        .ilike("platform_external_id", input.platform_external_id ?? "")
        .maybeSingle();
      if (existing) return { entity: existing, created: false };
    }

    const row = {
      entity_type: input.entity_type,
      name: input.name,
      canonical_url: input.canonical_url ?? null,
      platform: input.platform ?? null,
      platform_external_id: input.platform_external_id ?? null,
      description: input.description ?? null,
      location: input.location ?? null,
      metadata: input.metadata ?? {},
      playlist_target_id: input.playlist_target_id ?? null,
      radio_target_id: input.radio_target_id ?? null,
      relationship_id: input.relationship_id ?? null,
      parent_entity_id: input.parent_entity_id ?? null,
    };
    const { data, error } = await db.from("growth_entities").insert(row).select("*").single();
    if (error) {
      // Racing insert on the partial unique index — fetch the winner.
      if (isUniqueViolation(error) && platform && extId) {
        const { data: existing } = await db
          .from("growth_entities")
          .select("*")
          .ilike("platform", input.platform ?? "")
          .ilike("platform_external_id", input.platform_external_id ?? "")
          .maybeSingle();
        if (existing) return { entity: existing, created: false };
      }
      throw new Error(`findOrCreateEntity failed: ${error.message}`);
    }
    // dedupeKey is informational here (entity uniqueness is the DB index); kept for logs.
    void entityDedupeKey(input);
    return { entity: data, created: true };
  }

  // ---- Opportunities -----------------------------------------------------

  /**
   * Boundary check for the DB-dependent parts of create-opportunity validation:
   * the referenced entity/track must exist, and (when the track's length is known)
   * the recommended clip must fit inside it. Throws OpportunityRequestError so the
   * API maps it to a clean 4xx instead of letting an FK/CHECK violation surface as
   * an opaque 500. Assumes the pure `validateCreateOpportunityInput` has already run
   * (ids are well-formed UUIDs, clip ordering is valid). Read-only.
   */
  async function assertCreatableReferences(input: GrowthOpportunityInput): Promise<void> {
    // Referenced entity must exist (entity_id is a NOT NULL RESTRICT FK — a missing
    // ref would otherwise be a 23503 at insert → 500).
    const { data: entity, error: entityErr } = await db
      .from("growth_entities")
      .select("id")
      .eq("id", input.entity_id)
      .maybeSingle();
    if (entityErr) throw new Error(`assertCreatableReferences (entity) failed: ${entityErr.message}`);
    if (!entity) throw new OpportunityRequestError(404, "entity_id does not reference an existing entity");

    // Referenced track (optional) must exist; if its duration is known, the clip
    // must fit. Duration is the one clip bound we cannot check without the DB.
    if (input.recommended_song_id != null) {
      const { data: track, error: trackErr } = await db
        .from("tracks")
        .select("id, duration_seconds")
        .eq("id", input.recommended_song_id)
        .maybeSingle();
      if (trackErr) throw new Error(`assertCreatableReferences (track) failed: ${trackErr.message}`);
      if (!track) throw new OpportunityRequestError(404, "recommended_song_id does not reference an existing track");

      const end = input.recommended_end_seconds;
      const start = input.recommended_start_seconds;
      if (end != null && track.duration_seconds != null) {
        const clip = validateClip(Number(start ?? 0), Number(end), Number(track.duration_seconds));
        if (!clip.ok) throw new OpportunityRequestError(400, clip.error ?? "invalid clip window");
      }
    }
  }

  async function createOpportunity(
    input: GrowthOpportunityInput,
    weights: Partial<ScoreWeights> = {},
  ) {
    const dedupe_key = opportunityDedupeKey({
      entity_id: input.entity_id,
      opportunity_type: input.opportunity_type,
      recommended_song_id: input.recommended_song_id,
      source_url: input.source_url,
    });

    const components = computeScoreComponents(input.scoreInput ?? {});
    const opportunity_score = compositeScore(components, weights);

    const row = {
      entity_id: input.entity_id,
      source_platform: input.source_platform ?? null,
      opportunity_type: input.opportunity_type,
      source_url: input.source_url ?? null,
      title: input.title,
      why_discovered: input.why_discovered ?? null,
      discovery_evidence: input.discovery_evidence ?? {},
      ...components,
      opportunity_score,
      score_version: SCORE_VERSION,
      scored_at: new Date().toISOString(),
      recommended_song_id: input.recommended_song_id ?? null,
      recommended_start_seconds: input.recommended_start_seconds ?? null,
      recommended_end_seconds: input.recommended_end_seconds ?? null,
      recommended_action: input.recommended_action ?? null,
      generated_message: input.generated_message ?? null,
      status: "new",
      dedupe_key,
    };

    const { data, error } = await db.from("growth_opportunities").insert(row).select("*").single();
    if (error) {
      if (isUniqueViolation(error)) {
        const { data: existing } = await db
          .from("growth_opportunities")
          .select("*")
          .eq("dedupe_key", dedupe_key)
          .maybeSingle();
        return { opportunity: existing, created: false, deduped: true };
      }
      throw new Error(`createOpportunity failed: ${error.message}`);
    }
    return { opportunity: data, created: true, deduped: false };
  }

  async function getOpportunity(id: string) {
    const { data, error } = await db
      .from("growth_opportunities")
      .select("*, entity:growth_entities(*)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`getOpportunity failed: ${error.message}`);
    return data;
  }

  async function listOpportunities(filters: ListFilters = {}, opts: ListOptions = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);

    // !inner so a filter on entity.entity_type actually filters PARENT rows (a plain
    // embed would only null-out the entity). Safe: entity_id is NOT NULL + FK, so
    // every opportunity has an entity and !inner never drops a real row.
    let q = db
      .from("growth_opportunities")
      .select("*, entity:growth_entities!inner(*)", { count: "exact" });

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      q = q.in("status", statuses);
    }
    if (filters.opportunity_type) q = q.eq("opportunity_type", filters.opportunity_type);
    if (filters.source_platform) q = q.eq("source_platform", filters.source_platform);
    if (filters.recommended_song_id) q = q.eq("recommended_song_id", filters.recommended_song_id);
    if (filters.min_score != null) q = q.gte("opportunity_score", filters.min_score);
    if (filters.max_risk != null) q = q.lte("risk_score", filters.max_risk);
    if (filters.min_relationship != null) q = q.gte("relationship_score", filters.min_relationship);
    if (filters.discovered_after) q = q.gte("discovered_at", filters.discovered_after);
    if (filters.discovered_before) q = q.lte("discovered_at", filters.discovered_before);
    if (filters.entity_type) q = q.eq("entity.entity_type", filters.entity_type);
    if (filters.search) q = q.ilike("title", `%${filters.search}%`);

    q = opts.order === "recent"
      ? q.order("discovered_at", { ascending: false })
      : q.order("opportunity_score", { ascending: false, nullsFirst: false });

    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw new Error(`listOpportunities failed: ${error.message}`);
    return { rows: data ?? [], total: count ?? (data ? data.length : 0), limit, offset };
  }

  async function patchOpportunity(id: string, patch: Record<string, unknown>) {
    const allowed = [
      "generated_message",
      "recommended_action",
      "recommended_song_id",
      "recommended_start_seconds",
      "recommended_end_seconds",
      "assigned_to",
      "title",
      "why_discovered",
    ];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    if (Object.keys(clean).length === 0) return getOpportunity(id);
    const { data, error } = await db
      .from("growth_opportunities")
      .update(clean)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`patchOpportunity failed: ${error.message}`);
    return data;
  }

  /**
   * Generate a recommended action + draft message for an opportunity and store
   * them. Same code the API's generate-action route calls (keeps the edge
   * function thin and this path unit-tested).
   */
  async function generateAction(id: string, actor: Actor) {
    const opp = await getOpportunity(id);
    if (!opp) throw new Error("Opportunity not found");

    let songName: string | null = null;
    if (opp.recommended_song_id) {
      const { data: track } = await db
        .from("tracks")
        .select("name")
        .eq("id", opp.recommended_song_id)
        .maybeSingle();
      songName = track?.name ?? null;
    }

    const entity = opp.entity ?? {};
    const recommended_action = recommendAction(opp.opportunity_type);
    const { message } = generateMessage({
      entityName: entity.name,
      entityType: entity.entity_type,
      songName,
      clipStart: opp.recommended_start_seconds,
      clipEnd: opp.recommended_end_seconds,
      sourceUrl: opp.source_url,
      whyDiscovered: opp.why_discovered,
    });

    const updated = await patchOpportunity(id, {
      recommended_action,
      generated_message: message,
    });
    await recordAction(id, "generate_message", actor, { detail: { recommended_action } });
    return updated;
  }

  async function recordAction(
    id: string,
    action_type: string,
    actor: Actor,
    extra: Record<string, unknown> = {},
  ) {
    const { error } = await db.from("opportunity_actions").insert({
      opportunity_id: id,
      action_type,
      actor_user_id: actor.userId ?? null,
      actor_kind: actor.kind ?? "user",
      ...extra,
    });
    if (error) throw new Error(`recordAction failed: ${error.message}`);
  }

  async function transition(
    id: string,
    to: OpportunityStatus,
    actor: Actor,
    fields: Record<string, unknown> = {},
  ) {
    const current = await getOpportunity(id);
    if (!current) throw new Error("Opportunity not found");
    const from = current.status as OpportunityStatus;
    assertTransition(from, to); // throws IllegalTransitionError

    const update: Record<string, unknown> = { status: to, ...fields };
    if (["approved", "rejected", "contacted", "converted"].includes(to)) {
      update.acted_at = new Date().toISOString();
    }
    const { data, error } = await db
      .from("growth_opportunities")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`transition failed: ${error.message}`);
    await recordAction(id, `status:${to}`, actor, { from_status: from, to_status: to });
    return data;
  }

  async function recordOutcome(id: string, outcome: OutcomeRow, actor: Actor) {
    const current = await getOpportunity(id);
    if (!current) throw new Error("Opportunity not found");

    const { data: inserted, error } = await db
      .from("opportunity_outcomes")
      .insert({
        opportunity_id: id,
        outcome_type: outcome.outcome_type,
        succeeded: outcome.succeeded ?? null,
        response_received: outcome.response_received ?? false,
        converted: outcome.converted ?? false,
        conversion_value: outcome.conversion_value ?? 0,
        responded_at: outcome.responded_at ?? null,
        converted_at: outcome.converted_at ?? null,
        recorded_by: actor.userId ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(`recordOutcome failed: ${error.message}`);

    await recordAction(id, `outcome:${outcome.outcome_type}`, actor, {
      detail: { outcome_id: inserted?.id },
    });

    // An outcome updates RELATIONSHIP HISTORY: map it to a relationship event so
    // the entity's memory (and thus its relationship_score on recalc) reflects
    // what actually happened. Idempotent on (source, source_id, event_type).
    const relEventType = OUTCOME_TO_REL_EVENT[outcome.outcome_type];
    if (relEventType && current.entity_id) {
      await recordRelationshipEvent(current.entity_id, {
        event_type: relEventType,
        opportunity_id: id,
        relationship_id: current.entity?.relationship_id ?? undefined,
        channel: (outcome as { channel?: string }).channel,
        direction: "inbound",
        source: "opportunity_outcome",
        source_id: inserted?.id,
      });
    }

    // Advance status to the furthest realized point, if it's a legal move.
    const { data: outcomes } = await db
      .from("opportunity_outcomes")
      .select("*")
      .eq("opportunity_id", id);
    const state = deriveOutcomeState((outcomes ?? []) as OutcomeRow[]);
    if (state.derivedStatus) {
      try {
        await transition(id, state.derivedStatus, { kind: "service" });
      } catch {
        // Illegal jump (e.g. already closed) — leave status as-is; outcome is logged.
      }
    }
    const recalc = await recalcScore(id);
    return { outcome: inserted, score: recalc?.opportunity_score ?? null };
  }

  async function recalcScore(id: string, weights: Partial<ScoreWeights> = {}) {
    const current = await getOpportunity(id);
    if (!current) return null;

    // Human override wins — never silently discard a pinned score.
    if (current.score_overridden && current.manual_score != null) {
      return { opportunity_score: current.manual_score, overridden: true };
    }

    const { data: outcomes } = await db
      .from("opportunity_outcomes")
      .select("*")
      .eq("opportunity_id", id);
    const signals = outcomeScoreSignals((outcomes ?? []) as OutcomeRow[]);

    // Pull the entity's live relationship memory into the relationship_score
    // component, so accrued history (from outcomes/events) actually moves the
    // composite. This is the closed loop: outcome -> event -> memory -> score.
    const rel = current.entity_id
      ? await aggregateRelationshipForEntity(current.entity_id)
      : { score: current.relationship_score ?? 0 };

    // Recompute components from the ORIGINAL component values, layering realized
    // outcome signals + relationship memory on top. We keep the original
    // components as the base rather than re-deriving from raw discovery signals
    // (which we no longer hold).
    const base = {
      audience_match_score: current.audience_match_score ?? 50,
      relationship_score: rel.score,
      reach_score: current.reach_score ?? 0,
      response_probability: signals.warmth != null ? signals.warmth * 100 : current.response_probability ?? 0,
      conversion_probability: signals.historicConversion != null
        ? Math.max(current.conversion_probability ?? 0, signals.historicConversion * (current.response_probability ?? 0) / 100 * 100)
        : current.conversion_probability ?? 0,
      effort_score: current.effort_score ?? 50,
      lifetime_value_score: current.lifetime_value_score ?? 50,
      risk_score: current.risk_score ?? 20,
    };
    const opportunity_score = compositeScore(base, weights);
    const { data, error } = await db
      .from("growth_opportunities")
      .update({
        ...base,
        opportunity_score,
        score_version: SCORE_VERSION,
        scored_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("opportunity_score")
      .single();
    if (error) throw new Error(`recalcScore failed: ${error.message}`);
    return { opportunity_score: data?.opportunity_score ?? opportunity_score, overridden: false };
  }

  async function overrideScore(id: string, manual_score: number, reason: string, actor: Actor) {
    const { data, error } = await db
      .from("growth_opportunities")
      .update({ score_overridden: true, manual_score, override_reason: reason })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`overrideScore failed: ${error.message}`);
    await recordAction(id, "override_score", actor, { detail: { manual_score, reason } });
    return data;
  }

  // ---- Relationship memory ----------------------------------------------
  async function recordRelationshipEvent(
    entityId: string,
    event: RelationshipEvent & { opportunity_id?: string; relationship_id?: string; channel?: string; source?: string; source_id?: string; payload?: Record<string, unknown> },
  ) {
    const { error } = await db.from("growth_relationship_events").insert({
      entity_id: entityId,
      opportunity_id: event.opportunity_id ?? null,
      relationship_id: event.relationship_id ?? null,
      event_type: event.event_type,
      direction: event.direction ?? "system",
      channel: event.channel ?? null,
      // Persist the effective weight (explicit override, else the event-type
      // default) so the stored row is self-describing for later aggregation.
      weight: event.weight ?? EVENT_WEIGHTS[event.event_type] ?? 0,
      source: event.source ?? null,
      source_id: event.source_id ?? null,
      payload: event.payload ?? {},
    });
    // Idempotent: swallow the unique(source, source_id, event_type) collision.
    if (error && !isUniqueViolation(error)) {
      throw new Error(`recordRelationshipEvent failed: ${error.message}`);
    }
  }

  async function aggregateRelationshipForEntity(entityId: string) {
    const { data, error } = await db
      .from("growth_relationship_events")
      .select("event_type, direction, weight, occurred_at")
      .eq("entity_id", entityId);
    if (error) throw new Error(`aggregateRelationship failed: ${error.message}`);
    return aggregateRelationship((data ?? []) as RelationshipEvent[]);
  }

  // ---- Stats -------------------------------------------------------------
  async function stats() {
    const { data, error } = await db
      .from("growth_opportunities")
      .select("status, opportunity_type, opportunity_score");
    if (error) throw new Error(`stats failed: ${error.message}`);
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let scoreSum = 0;
    let scored = 0;
    for (const r of data ?? []) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      byType[r.opportunity_type] = (byType[r.opportunity_type] ?? 0) + 1;
      if (r.opportunity_score != null) {
        scoreSum += Number(r.opportunity_score);
        scored += 1;
      }
    }
    return {
      total: (data ?? []).length,
      by_status: byStatus,
      by_type: byType,
      avg_score: scored ? Math.round((scoreSum / scored) * 100) / 100 : null,
    };
  }

  // ---- Conversations + Interactions -------------------------------------
  // A thin, admin-gated surface over the EXISTING growth_conversations +
  // growth_interactions tables so the daily growth op can: find-or-create the
  // business conversation with an org, record a PROPOSED outbound touch, and
  // advance that touch's status after a human acts — associating each touch with
  // its opportunity + entity/contact. The interaction lifecycle status
  // (proposed -> sent -> responded ...) lives in payload.status (the table is
  // channel-polymorphic and has no status column); everything else maps to a
  // real column.

  async function loadEntity(entityId: string): Promise<{ id: string; parent_entity_id: string | null } | null> {
    const { data, error } = await db
      .from("growth_entities")
      .select("id, parent_entity_id")
      .eq("id", entityId)
      .maybeSingle();
    if (error) throw new Error(`entity lookup failed: ${error.message}`);
    return (data as { id: string; parent_entity_id: string | null } | null) ?? null;
  }

  /** Two entities are in the same org hierarchy when they are equal, or one is the
   *  other's parent (org <-> its child contact). Used to keep an interaction/
   *  conversation from being cross-wired to a different organization. */
  function sameOrgHierarchy(
    a: { id: string; parent_entity_id?: string | null } | null,
    b: { id: string; parent_entity_id?: string | null } | null,
  ): boolean {
    if (!a || !b) return false;
    return a.id === b.id || a.parent_entity_id === b.id || b.parent_entity_id === a.id;
  }

  async function assertOpportunityExists(oppId: string): Promise<void> {
    const { data, error } = await db.from("growth_opportunities").select("id").eq("id", oppId).maybeSingle();
    if (error) throw new Error(`opportunity lookup failed: ${error.message}`);
    if (!data) throw new OpportunityRequestError(404, "opportunity_id does not reference an existing opportunity");
  }

  /**
   * Find the conversation for an (entity, opportunity) pair, or create one. The
   * conversation is the BUSINESS relationship — identified by its own id, keyed
   * here by entity (+ optional opportunity) so the daily op is idempotent and
   * never spawns a duplicate thread for the same target.
   */
  async function findOrCreateConversation(input: ConversationInput) {
    // NOT NULL FK — a missing entity would otherwise be a 23503 -> opaque 500.
    const convEntity = await loadEntity(input.entity_id);
    if (!convEntity) throw new OpportunityRequestError(404, "entity_id does not reference an existing entity");

    if (input.opportunity_id) {
      // The opportunity must exist AND belong to the same organization as the
      // conversation entity — otherwise the thread is cross-wired (entity = Org A,
      // opportunity = Org B) and every later interaction consistency check would
      // wrongly pass. Enforce it HERE, at creation. Mismatch -> 409.
      const { data: opp, error: oppErr } = await db
        .from("growth_opportunities")
        .select("id, entity_id")
        .eq("id", input.opportunity_id)
        .maybeSingle();
      if (oppErr) throw new Error(`opportunity lookup failed: ${oppErr.message}`);
      if (!opp) throw new OpportunityRequestError(404, "opportunity_id does not reference an existing opportunity");

      const oppEntity = opp.entity_id === convEntity.id ? convEntity : await loadEntity(opp.entity_id);
      if (!sameOrgHierarchy(convEntity, oppEntity)) {
        throw new OpportunityRequestError(
          409,
          "conversation entity does not belong to the opportunity's organization",
        );
      }
    }

    // Match on (entity_id [, opportunity_id]). Filtered by entity_id (and
    // opportunity_id when present); the opportunity-less case is resolved in JS
    // to avoid an `.eq(col, null)` (which is not an IS NULL against PostgREST).
    let q = db.from("growth_conversations").select("*").eq("entity_id", input.entity_id);
    if (input.opportunity_id) q = q.eq("opportunity_id", input.opportunity_id);
    const { data: rows, error: findErr } = await q;
    if (findErr) throw new Error(`findOrCreateConversation (find) failed: ${findErr.message}`);
    const existing = input.opportunity_id
      ? (rows ?? [])[0]
      : (rows ?? []).find((r: Record<string, unknown>) => r.opportunity_id == null);
    if (existing) return { conversation: existing, created: false };

    const row = {
      entity_id: input.entity_id,
      opportunity_id: input.opportunity_id ?? null,
      subject: input.subject ?? null,
      status: input.status ?? "open",
    };
    const { data, error } = await db.from("growth_conversations").insert(row).select("*").single();
    if (error) {
      // Concurrency: a parallel Cowork agent won the race and inserted first. The
      // partial unique indexes (entity_id, opportunity_id) / (entity_id) make the
      // loser hit 23505 — re-fetch and return the WINNER instead of erroring, so
      // find-or-create is truly idempotent under parallelism.
      if (isUniqueViolation(error)) {
        let rq = db.from("growth_conversations").select("*").eq("entity_id", input.entity_id);
        if (input.opportunity_id) rq = rq.eq("opportunity_id", input.opportunity_id);
        const { data: rows2 } = await rq;
        const winner = input.opportunity_id
          ? (rows2 ?? [])[0]
          : (rows2 ?? []).find((r: Record<string, unknown>) => r.opportunity_id == null);
        if (winner) return { conversation: winner, created: false };
      }
      throw new Error(`findOrCreateConversation failed: ${error.message}`);
    }
    return { conversation: data, created: true };
  }

  async function getConversation(id: string) {
    const { data, error } = await db.from("growth_conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getConversation failed: ${error.message}`);
    return data;
  }

  async function listConversations(filters: ConversationFilters = {}) {
    let q = db.from("growth_conversations").select("*");
    if (filters.entity_id) q = q.eq("entity_id", filters.entity_id);
    if (filters.opportunity_id) q = q.eq("opportunity_id", filters.opportunity_id);
    if (filters.status) q = q.eq("status", filters.status);
    q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw new Error(`listConversations failed: ${error.message}`);
    return { rows: data ?? [] };
  }

  /**
   * Record ONE interaction (a proposed outbound touch by default). Associates the
   * touch with its conversation + entity/contact + opportunity, captures the
   * channel/direction/provider refs, and folds the lifecycle status + evidence/
   * source into payload. Idempotent on the provider (interaction_type,
   * external_message_id) unique constraint.
   */
  // Reject attaching a Smart Link slug/short_code already claimed by a DIFFERENT
  // interaction (per-target links must be unique). API-level check — sufficient at
  // Week-1 scale; does not redesign smart_links.
  async function assertSmartLinkUnused(
    link: { slug?: string | null; short_code?: string | null },
    exceptId: string | null,
  ): Promise<void> {
    const refs = [link.slug, link.short_code].filter(Boolean) as string[];
    for (const ref of refs) {
      const { rows } = await findInteractionsBySmartLink(ref);
      if (rows.some((r: Record<string, unknown>) => r.id !== exceptId)) {
        throw new OpportunityRequestError(409, "smart_link is already associated with another interaction");
      }
    }
  }

  /** Resolve an interaction by its Cowork-supplied idempotency_key (stored in
   *  payload.idempotency_key). JS-filtered so it runs identically under the Deno
   *  client and the vitest stub (pilot volume is tiny; the DB unique expression
   *  index is the concurrency backstop). */
  async function findInteractionByIdempotencyKey(key: string) {
    const { data, error } = await db.from("growth_interactions").select("*");
    if (error) throw new Error(`findInteractionByIdempotencyKey failed: ${error.message}`);
    return (data ?? []).find(
      (r: Record<string, unknown>) =>
        (r.payload as { idempotency_key?: string } | null)?.idempotency_key === key,
    ) ?? null;
  }

  async function recordInteraction(input: InteractionInput) {
    // Deterministic proposal-stage idempotency: a Cowork op supplies an explicit
    // idempotency_key. A retry / timeout / parallel agent submitting the SAME
    // touch must yield ONE interaction. Fast-path pre-check for retries; the DB
    // unique expression index on payload->>'idempotency_key' is the race backstop
    // (caught below). Does NOT overload external_message_id.
    if (input.idempotency_key) {
      const dup = await findInteractionByIdempotencyKey(input.idempotency_key);
      if (dup) return { interaction: dup, created: false, deduped: true };
    }

    // Existence — return a clean 404 rather than letting an FK 23503 become a 500.
    let conversation: Record<string, unknown> | null = null;
    if (input.conversation_id) {
      conversation = await getConversation(input.conversation_id);
      if (!conversation) throw new OpportunityRequestError(404, "conversation_id does not reference an existing conversation");
    }
    let entity: { id: string; parent_entity_id?: string | null } | null = null;
    if (input.entity_id) {
      entity = await loadEntity(input.entity_id);
      if (!entity) throw new OpportunityRequestError(404, "entity_id does not reference an existing entity");
    }
    if (input.opportunity_id) await assertOpportunityExists(input.opportunity_id);

    // Relational consistency: an interaction is a TOUCH WITHIN its conversation.
    // Its opportunity must agree with the conversation's, and its entity/contact
    // must belong to the conversation's organization (the org itself, or a child
    // contact via parent_entity_id). A mismatch is a 409 — never miswire the graph.
    if (conversation) {
      if (
        conversation.opportunity_id && input.opportunity_id &&
        conversation.opportunity_id !== input.opportunity_id
      ) {
        throw new OpportunityRequestError(409, "interaction opportunity does not match its conversation");
      }
      if (entity) {
        const convOrg = { id: conversation.entity_id as string, parent_entity_id: null };
        if (!sameOrgHierarchy(entity, convOrg)) {
          throw new OpportunityRequestError(
            409,
            "interaction entity/contact does not belong to the conversation's organization",
          );
        }
      }
    }

    // Per-target Smart Link must be unique across interactions.
    if (input.smart_link) await assertSmartLinkUnused(input.smart_link, null);

    const occurred_at = input.occurred_at ?? new Date().toISOString();
    const payload: Record<string, unknown> = {
      ...(input.payload ?? {}),
      status: input.status ?? DEFAULT_INTERACTION_STATUS,
    };
    if (input.evidence !== undefined) payload.evidence = input.evidence;
    if (input.source) payload.source = input.source;
    // The Cowork idempotency_key lives in payload (enforced by a partial unique
    // expression index) — this is what makes a proposed touch idempotent before a
    // provider message id exists.
    if (input.idempotency_key) payload.idempotency_key = input.idempotency_key;
    // Record the UNIQUE per-target Smart Link on the interaction (spec §10). A
    // click resolves back to this opportunity via findInteractionsBySmartLink —
    // no column on the Lovable-managed smart_links / link_analytics tables.
    if (input.smart_link) payload.smart_link = input.smart_link;

    const row = {
      conversation_id: input.conversation_id ?? null,
      entity_id: input.entity_id ?? null,
      opportunity_id: input.opportunity_id ?? null,
      interaction_type: input.interaction_type,
      direction: input.direction,
      occurred_at,
      subject: input.subject ?? null,
      body_preview: input.body_preview ?? null,
      external_thread_ref: input.external_thread_ref ?? null,
      external_message_id: input.external_message_id ?? null,
      in_reply_to: input.in_reply_to ?? null,
      match_status: input.match_status,
      payload,
    };

    const { data, error } = await db.from("growth_interactions").insert(row).select("*").single();
    if (error) {
      // Race backstop: a parallel agent inserted the same touch first. Resolve to
      // the winner by whichever uniqueness fired —
      //  * proposal idempotency: payload.idempotency_key
      //  * provider idempotency: (interaction_type, external_message_id)
      if (isUniqueViolation(error)) {
        if (input.idempotency_key) {
          const dup = await findInteractionByIdempotencyKey(input.idempotency_key);
          if (dup) return { interaction: dup, created: false, deduped: true };
        }
        if (input.external_message_id) {
          const { data: existing } = await db
            .from("growth_interactions")
            .select("*")
            .eq("interaction_type", input.interaction_type)
            .eq("external_message_id", input.external_message_id)
            .maybeSingle();
          if (existing) return { interaction: existing, created: false, deduped: true };
        }
      }
      throw new Error(`recordInteraction failed: ${error.message}`);
    }

    // Keep the conversation's last_interaction_at current so the thread reflects
    // this touch (best-effort; never blocks the interaction write).
    if (input.conversation_id) {
      await db.from("growth_conversations")
        .update({ last_interaction_at: occurred_at })
        .eq("id", input.conversation_id);
    }
    return { interaction: data, created: true, deduped: false };
  }

  async function getInteraction(id: string) {
    const { data, error } = await db.from("growth_interactions").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getInteraction failed: ${error.message}`);
    return data;
  }

  async function listInteractions(filters: InteractionFilters = {}) {
    let q = db.from("growth_interactions").select("*");
    if (filters.conversation_id) q = q.eq("conversation_id", filters.conversation_id);
    if (filters.opportunity_id) q = q.eq("opportunity_id", filters.opportunity_id);
    if (filters.entity_id) q = q.eq("entity_id", filters.entity_id);
    q = q.order("occurred_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw new Error(`listInteractions failed: ${error.message}`);
    return { rows: data ?? [] };
  }

  /**
   * Advance an interaction's lifecycle status after a human action (e.g. a
   * proposed touch was actually sent, or a reply came in). Enforces a monotone
   * transition against the stored payload.status so a touch can never silently
   * rewind, and lets the caller set the provider ids / match_status realized by
   * the action.
   */
  async function updateInteractionStatus(id: string, patch: InteractionStatusUpdate) {
    const current = await getInteraction(id);
    if (!current) throw new OpportunityRequestError(404, "interaction not found");

    const from = ((current.payload && current.payload.status) ?? DEFAULT_INTERACTION_STATUS) as InteractionStatus;
    assertInteractionStatusTransition(from, patch.status); // throws exposable 409

    const payload = { ...(current.payload ?? {}), status: patch.status };
    // The per-target link is often minted at send time — let the status advance
    // attach/replace it in the same call, but only if no OTHER interaction already
    // claims that slug/short_code (409 otherwise).
    if (patch.smart_link) {
      await assertSmartLinkUnused(patch.smart_link, id);
      payload.smart_link = patch.smart_link;
    }
    const update: Record<string, unknown> = { payload };
    if (patch.match_status != null) update.match_status = patch.match_status;
    if (patch.external_message_id != null) update.external_message_id = patch.external_message_id;
    if (patch.external_thread_ref != null) update.external_thread_ref = patch.external_thread_ref;
    if (patch.occurred_at != null) update.occurred_at = patch.occurred_at;
    if (patch.body_preview != null) update.body_preview = patch.body_preview;

    const { data, error } = await db
      .from("growth_interactions")
      .update(update)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(`updateInteractionStatus failed: ${error.message}`);
    return data;
  }

  /**
   * Resolve a Smart Link identifier (slug OR short_code, as carried back by a
   * click) to the interaction(s) — and thus the opportunity — it was attached to.
   * This is the read half of the §10 attribution path: click ->
   * link_analytics.link_id -> smart_links.short_code/slug -> HERE -> opportunity_id,
   * with no schema change on the smart-link side. Filters payload.smart_link in
   * JS so it runs identically under the Deno client and the vitest stub (pilot
   * volume is tiny; Phase 2 can index payload->>'short_code').
   */
  async function findInteractionsBySmartLink(ref: string) {
    if (!ref) return { rows: [] as Record<string, unknown>[] };
    const { data, error } = await db.from("growth_interactions").select("*");
    if (error) throw new Error(`findInteractionsBySmartLink failed: ${error.message}`);
    const rows = (data ?? []).filter((r: Record<string, unknown>) => {
      const link = (r.payload as { smart_link?: { slug?: string; short_code?: string } } | null)?.smart_link;
      return !!link && (link.slug === ref || link.short_code === ref);
    });
    return { rows };
  }

  return {
    findOrCreateEntity,
    assertCreatableReferences,
    findOrCreateConversation,
    getConversation,
    listConversations,
    recordInteraction,
    getInteraction,
    listInteractions,
    updateInteractionStatus,
    findInteractionsBySmartLink,
    createOpportunity,
    getOpportunity,
    listOpportunities,
    patchOpportunity,
    generateAction,
    recordAction,
    transition,
    recordOutcome,
    recalcScore,
    overrideScore,
    recordRelationshipEvent,
    aggregateRelationshipForEntity,
    stats,
  };
}

export type OpportunityRepository = ReturnType<typeof createOpportunityRepository>;

export { DEFAULT_WEIGHTS };
