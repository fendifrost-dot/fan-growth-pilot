/**
 * Batch-level drafted_by attribution helpers for playlist inventory.
 * Attribution always comes from authenticated OpsActor — never caller body.
 */
import {
  attributionFrom,
  stripSpoofedAttribution,
  type OpsActor,
  type OpsActorKind,
} from "./ops-actors.ts";

/** Actors considered authenticated for safe historical backfill. */
export const AUTHENTICATED_BATCH_ACTORS = new Set<string>([
  "claude_playlist_discovery",
  "claude",
  "grok_playlist_control",
  "fendi",
  "scheduler",
  "service",
  "human_admin",
]);

/** Server-only attr payload for agh_mcp_persist_playlist_inventory. */
export function buildServerInventoryAttr(ops: OpsActor): {
  discovered_by: OpsActorKind;
  discovered_by_label: string;
  drafted_by: OpsActorKind;
  drafted_by_label: string;
} {
  const attr = attributionFrom(ops);
  return {
    discovered_by: attr.actor_kind,
    discovered_by_label: attr.actor_label,
    drafted_by: attr.actor_kind,
    drafted_by_label: attr.actor_label,
  };
}

/**
 * Strip spoofed attribution from a caller body, then rebuild inventory attr
 * exclusively from the authenticated actor.
 */
export function inventoryAttrFromAuthenticatedActor(
  ops: OpsActor,
  body: Record<string, unknown>,
): ReturnType<typeof buildServerInventoryAttr> {
  // Prove caller drafted_by / discovered_by cannot survive into the attr.
  stripSpoofedAttribution(body);
  return buildServerInventoryAttr(ops);
}

export type BatchAttributionRow = {
  id: string;
  drafted_by?: string | null;
  drafted_by_label?: string | null;
  batch_kind?: string | null;
  queue_state?: string | null;
};

export type RecordAttributionRow = {
  batch_id: string;
  drafted_by?: string | null;
  drafted_by_label?: string | null;
  discovered_by?: string | null;
  discovered_by_label?: string | null;
};

export type BatchDraftedByBackfillPlan = {
  updates: Array<{
    batch_id: string;
    drafted_by: string;
    drafted_by_label: string;
    queue_state: string | null;
  }>;
  reconciliation: Array<{
    batch_id: string;
    reason: "no_record_actor" | "mixed_record_actors" | "unauthenticated_actor";
    actors: string[];
  }>;
};

function recordActor(r: RecordAttributionRow): string | null {
  const drafted = String(r.drafted_by ?? "").trim();
  if (drafted) return drafted;
  const discovered = String(r.discovered_by ?? "").trim();
  return discovered || null;
}

function recordLabel(r: RecordAttributionRow, actor: string): string | null {
  const draftedActor = String(r.drafted_by ?? "").trim();
  const discoveredActor = String(r.discovered_by ?? "").trim();
  if (draftedActor === actor) {
    const label = String(r.drafted_by_label ?? "").trim();
    if (label) return label;
  }
  if (discoveredActor === actor || (!draftedActor && discoveredActor === actor)) {
    const label = String(r.discovered_by_label ?? "").trim();
    if (label) return label;
  }
  return null;
}

/**
 * Pure planner mirroring agh_backfill_batch_drafted_by.
 * Only null drafted_by playlist batches; never changes queue_state or records.
 */
export function planBatchDraftedByBackfill(
  batches: BatchAttributionRow[],
  records: RecordAttributionRow[],
): BatchDraftedByBackfillPlan {
  const updates: BatchDraftedByBackfillPlan["updates"] = [];
  const reconciliation: BatchDraftedByBackfillPlan["reconciliation"] = [];

  for (const batch of batches) {
    if (batch.drafted_by != null && String(batch.drafted_by).trim() !== "") continue;
    if (batch.batch_kind != null && batch.batch_kind !== "playlist") continue;

    const batchRecords = records.filter((r) => String(r.batch_id) === String(batch.id));
    const actors = [
      ...new Set(
        batchRecords.map(recordActor).filter((a): a is string => Boolean(a)),
      ),
    ].sort();

    if (actors.length === 0) {
      reconciliation.push({
        batch_id: String(batch.id),
        reason: "no_record_actor",
        actors: [],
      });
      continue;
    }
    if (actors.length > 1) {
      reconciliation.push({
        batch_id: String(batch.id),
        reason: "mixed_record_actors",
        actors,
      });
      continue;
    }

    const actor = actors[0];
    if (!AUTHENTICATED_BATCH_ACTORS.has(actor)) {
      reconciliation.push({
        batch_id: String(batch.id),
        reason: "unauthenticated_actor",
        actors,
      });
      continue;
    }

    let label = actor;
    for (const r of batchRecords) {
      const hit = recordLabel(r, actor);
      if (hit) {
        label = hit;
        break;
      }
    }

    updates.push({
      batch_id: String(batch.id),
      drafted_by: actor,
      drafted_by_label: label,
      queue_state: batch.queue_state ?? null,
    });
  }

  return { updates, reconciliation };
}
