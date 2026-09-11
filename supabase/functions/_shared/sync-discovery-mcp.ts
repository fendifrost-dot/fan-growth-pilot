/**
 * Fixed tool handlers for the claude_sync_discovery remote MCP connector.
 * Tools call internal AGH sync-research logic under a fixed identity — never
 * forward arbitrary action names. OAuth bearer identity is sufficient.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  denyUnlessCan,
  type OpsActor,
} from "./ops-actors.ts";
import {
  advanceSyncBatch,
  getSyncDiscoveryWork,
  researchSyncTargets,
  submitSyncResearch,
  verifySyncTargets,
  createSyncOpportunity,
  draftSyncPitch,
  readOwnSyncBatches,
} from "./sync-research.ts";
import { startDailyStationRun, completeDailyStationRun } from "./daily-ops.ts";
import { stripSpoofedAttribution } from "./ops-actors.ts";

export type ToolResult = { status: number; data: Record<string, unknown> };

export const SYNC_DISCOVERY_TOOLS = [
  "get_sync_discovery_work",
  "submit_sync_targets",
  "submit_sync_opportunities",
  "create_sync_drafts",
  "verify_sync_contacts",
  "advance_sync_batch",
  "start_claude_sync_station",
  "complete_claude_sync_station",
  "get_own_sync_batches",
] as const;

export type SyncDiscoveryTool = (typeof SYNC_DISCOVERY_TOOLS)[number];

export function isSyncDiscoveryTool(name: string): name is SyncDiscoveryTool {
  return (SYNC_DISCOVERY_TOOLS as readonly string[]).includes(name);
}

export function syncDiscoveryActor(): OpsActor {
  return {
    kind: "claude_sync_discovery",
    userId: null,
    label: "claude_sync_discovery",
  };
}

export const SYNC_DISCOVERY_TOOL_SCHEMAS: Record<SyncDiscoveryTool, Record<string, unknown>> = {
  get_sync_discovery_work: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  submit_sync_targets: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "object" } },
    },
    required: ["targets"],
    additionalProperties: false,
  },
  submit_sync_opportunities: {
    type: "object",
    properties: {
      opportunities: { type: "array", items: { type: "object" } },
    },
    required: ["opportunities"],
    additionalProperties: false,
  },
  create_sync_drafts: {
    type: "object",
    properties: {
      drafts: { type: "array", items: { type: "object" } },
    },
    required: ["drafts"],
    additionalProperties: false,
  },
  verify_sync_contacts: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      id: { type: "string" },
    },
    additionalProperties: false,
  },
  advance_sync_batch: {
    type: "object",
    properties: {
      track_id: { type: "string" },
      business_date_ct: { type: "string" },
      target_ids: { type: "array", items: { type: "string" } },
      opportunity_ids: { type: "array", items: { type: "string" } },
      draft_ids: { type: "array", items: { type: "string" } },
      verified_count: { type: "number" },
      source_evidence_summary: { type: "string" },
      shortfalls: { type: "array" },
      notes: { type: "string" },
    },
    additionalProperties: false,
  },
  start_claude_sync_station: {
    type: "object",
    properties: {
      station_id: { type: "string" },
      business_date_ct: { type: "string" },
      run_key: { type: "string" },
    },
    additionalProperties: false,
  },
  complete_claude_sync_station: {
    type: "object",
    properties: {
      station_id: { type: "string" },
      business_date_ct: { type: "string" },
      run_key: { type: "string" },
      run_id: { type: "string" },
      status: { type: "string" },
      raw_discoveries: { type: "number" },
      unique_discoveries: { type: "number" },
      verified_targets: { type: "number" },
      drafts_created: { type: "number" },
      duplicates: { type: "number" },
      shortfall_reason: { type: "string" },
      output_batch_id: { type: "string" },
      metrics: { type: "object" },
    },
    additionalProperties: false,
  },
  get_own_sync_batches: {
    type: "object",
    properties: {
      limit: { type: "number" },
    },
    additionalProperties: false,
  },
};

export async function runSyncDiscoveryTool(
  name: string,
  args: Record<string, unknown>,
  sb: SupabaseClient,
  ops: OpsActor,
): Promise<ToolResult> {
  if (!isSyncDiscoveryTool(name)) {
    return { status: 400, data: { error: `unknown_tool:${name}` } };
  }
  // Fixed identity — ignore any spoofed actor fields in args.
  const clean = stripSpoofedAttribution(args);

  switch (name) {
    case "get_sync_discovery_work":
      return getSyncDiscoveryWork(sb, ops);

    case "submit_sync_targets":
      return researchSyncTargets(sb, clean, ops);

    case "submit_sync_opportunities": {
      const items = Array.isArray(clean.opportunities) ? clean.opportunities : [];
      const rows: unknown[] = [];
      for (const item of items) {
        const res = await createSyncOpportunity(
          sb,
          typeof item === "object" && item ? (item as Record<string, unknown>) : {},
          ops,
        );
        if (res.status >= 400) return res;
        rows.push(res.data.row);
      }
      return {
        status: 200,
        data: { ok: true, created: rows.length, rows },
      };
    }

    case "create_sync_drafts": {
      const items = Array.isArray(clean.drafts) ? clean.drafts : [];
      const created: unknown[] = [];
      const blocked: unknown[] = [];
      for (const item of items) {
        const res = await draftSyncPitch(
          sb,
          typeof item === "object" && item ? (item as Record<string, unknown>) : {},
          ops,
        );
        if (res.status === 422) {
          blocked.push(res.data);
          continue;
        }
        if (res.status >= 400) return res;
        created.push(res.data.draft);
      }
      return {
        status: 200,
        data: {
          ok: true,
          drafts: created.length,
          blocked: blocked.length,
          rows: created,
          blocked_rows: blocked,
          sent: false,
          approved: false,
        },
      };
    }

    case "verify_sync_contacts":
      return verifySyncTargets(sb, clean, ops);

    case "advance_sync_batch":
      return advanceSyncBatch(sb, clean, ops);

    case "start_claude_sync_station": {
      const denied = denyUnlessCan(ops, "run_daily_station");
      if (denied) return denied;
      return startDailyStationRun(
        sb,
        {
          station_id: String(clean.station_id ?? "sync_batch_ready"),
          business_date_ct: clean.business_date_ct,
          run_key: clean.run_key ?? "primary",
        },
        { kind: "claude_sync_discovery" },
        null,
      );
    }

    case "complete_claude_sync_station": {
      const denied = denyUnlessCan(ops, "run_daily_station");
      if (denied) return denied;
      return completeDailyStationRun(
        sb,
        {
          station_id: String(clean.station_id ?? "sync_batch_ready"),
          business_date_ct: clean.business_date_ct,
          run_key: clean.run_key ?? "primary",
          run_id: clean.run_id,
          status: clean.status ?? "completed",
          raw_discoveries: clean.raw_discoveries,
          unique_discoveries: clean.unique_discoveries,
          verified_targets: clean.verified_targets,
          drafts_created: clean.drafts_created,
          duplicates: clean.duplicates,
          shortfall_reason: clean.shortfall_reason,
          output_batch_id: clean.output_batch_id,
          metrics: clean.metrics,
        },
        { kind: "claude_sync_discovery" },
        null,
      );
    }

    case "get_own_sync_batches":
      return readOwnSyncBatches(sb, clean, ops);

    default:
      return { status: 400, data: { error: `unhandled_tool:${name}` } };
  }
}

// Keep submitSyncResearch available for station orchestration tests.
export { submitSyncResearch };
