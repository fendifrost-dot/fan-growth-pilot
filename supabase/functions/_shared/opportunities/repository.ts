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
import { assertTransition, deriveOutcomeState, outcomeScoreSignals } from "./outcomes.ts";
import { generateMessage, recommendAction } from "./messaging.ts";

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

  return {
    findOrCreateEntity,
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
