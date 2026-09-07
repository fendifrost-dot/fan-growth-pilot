/**
 * AGH daily station run ledger — idempotent per station / CT business date / run_key.
 * Retries resume or update the existing run; they must not duplicate research/drafts.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { Actor } from "./outreach-auth.ts";
import {
  attributionFrom,
  resolveOpsActor,
  stripSpoofedAttribution,
  type OpsActor,
} from "./ops-actors.ts";
import {
  authorizeStationOperator,
  chicagoBusinessDate,
  DAILY_STATION_IDS,
  isDailyStationId,
  STATION_REQUIRED_UPSTREAM_QUEUE,
  STATION_UPSTREAM,
  stationOwner,
  type DailyStationId,
} from "./chicago-time.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const DAILY_OPS_ACTIONS = [
  "start_daily_station_run",
  "complete_daily_station_run",
  "list_daily_station_runs",
  "get_daily_station_run",
  "get_daily_ops_dashboard",
  "list_ops_settings",
  "upsert_ops_setting",
] as const;

export function isDailyOpsAction(action: string): boolean {
  return (DAILY_OPS_ACTIONS as readonly string[]).includes(action);
}

type StationStatus = "running" | "completed" | "partial" | "blocked" | "failed";

function asInt(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

async function loadUpstream(
  sb: SupabaseClient,
  stationId: DailyStationId,
  businessDate: string,
): Promise<{
  upstream_station_id: string | null;
  upstream_run_id: string | null;
  input_batch_id: string | null;
  dependency_failure: string | null;
}> {
  const upstream = STATION_UPSTREAM[stationId] ?? null;
  if (!upstream) {
    return {
      upstream_station_id: null,
      upstream_run_id: null,
      input_batch_id: null,
      dependency_failure: null,
    };
  }
  const { data } = await sb
    .from("daily_ops_station_runs")
    .select("id, status, output_batch_id, error_summary")
    .eq("station_id", upstream)
    .eq("business_date_ct", businessDate)
    .eq("run_key", "primary")
    .maybeSingle();
  if (!data) {
    return {
      upstream_station_id: upstream,
      upstream_run_id: null,
      input_batch_id: null,
      dependency_failure: `upstream_missing:${upstream}`,
    };
  }
  const failed = data.status === "failed" || data.status === "blocked";
  return {
    upstream_station_id: upstream,
    upstream_run_id: data.id as string,
    input_batch_id: (data.output_batch_id as string | null) ?? null,
    dependency_failure: failed
      ? `upstream_${data.status}:${upstream}${data.error_summary ? `:${data.error_summary}` : ""}`
      : null,
  };
}

export async function startDailyStationRun(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  const clean = stripSpoofedAttribution(body);
  const stationRaw = String(clean.station_id ?? "").trim();
  if (!isDailyStationId(stationRaw)) {
    return {
      status: 400,
      data: {
        error: `Unknown station_id. Allowed: ${DAILY_STATION_IDS.join(", ")}`,
      },
    };
  }
  const stationId = stationRaw as DailyStationId;
  const startDenied = authorizeStationOperator(stationId, ops.kind, "start");
  if (startDenied) return { status: 403, data: { error: startDenied, code: "station_ownership" } };

  const businessDate =
    typeof clean.business_date_ct === "string" && /^\d{4}-\d{2}-\d{2}$/.test(clean.business_date_ct)
      ? clean.business_date_ct
      : chicagoBusinessDate();
  const runKey = String(clean.run_key ?? "primary").trim() || "primary";
  const attr = attributionFrom(ops);
  const owner = stationOwner(stationId);

  // Idempotent upsert: resume existing run rather than insert a duplicate.
  const { data: existing } = await sb
    .from("daily_ops_station_runs")
    .select("*")
    .eq("station_id", stationId)
    .eq("business_date_ct", businessDate)
    .eq("run_key", runKey)
    .maybeSingle();

  const upstream = await loadUpstream(sb, stationId, businessDate);

  // Grok stations cannot front-run required upstream queue states.
  const requiredQueue = STATION_REQUIRED_UPSTREAM_QUEUE[stationId];
  let queueDependency: string | null = null;
  if (requiredQueue && upstream.input_batch_id) {
    const { data: batch } = await sb
      .from("agh_handoff_batches")
      .select("id, queue_state")
      .eq("id", upstream.input_batch_id)
      .maybeSingle();
    if (!batch || String(batch.queue_state) !== requiredQueue) {
      queueDependency =
        `upstream_queue_not_ready:need_${requiredQueue}:got_${batch?.queue_state ?? "missing"}`;
    }
  } else if (requiredQueue && !upstream.input_batch_id) {
    queueDependency = `upstream_queue_not_ready:need_${requiredQueue}:no_batch`;
  }

  if (existing) {
    const resumeDenied = authorizeStationOperator(stationId, ops.kind, "resume");
    if (resumeDenied) return { status: 403, data: { error: resumeDenied, code: "station_ownership" } };
    // A caller may only resume a run owned by its operator class.
    if (existing.owner_kind && existing.owner_kind !== owner && ops.kind !== "fendi") {
      return {
        status: 403,
        data: { error: `Cannot resume ${existing.owner_kind}-owned station run`, code: "station_ownership" },
      };
    }
    // Resume — preserve original authenticated actor attribution (no overwrite).
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      upstream_station_id: upstream.upstream_station_id,
      upstream_run_id: upstream.upstream_run_id,
      input_batch_id: existing.input_batch_id ?? upstream.input_batch_id,
      dependency_failure: queueDependency ?? upstream.dependency_failure,
      last_resumed_by: attr.actor_kind,
      last_resumed_by_label: attr.actor_label,
      last_resumed_at: new Date().toISOString(),
    };
    if (existing.status === "completed" && !clean.force_reopen) {
      return {
        status: 200,
        data: {
          ok: true,
          resumed: true,
          already_complete: true,
          run: existing,
          dependency_failure: upstream.dependency_failure,
        },
      };
    }
    if (existing.status !== "running") {
      patch.status = "running";
      patch.started_at = existing.started_at ?? new Date().toISOString();
      patch.completed_at = null;
    }
    const { data, error } = await sb
      .from("daily_ops_station_runs")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return { status: 500, data: { error: error.message } };
    return {
      status: 200,
      data: {
        ok: true,
        resumed: true,
        run: data,
        dependency_failure: upstream.dependency_failure,
        continue_safe_work: true,
      },
    };
  }

  const insert = {
    station_id: stationId,
    business_date_ct: businessDate,
    run_key: runKey,
    actor_kind: attr.actor_kind,
    actor_label: attr.actor_label,
    actor_user_id: attr.actor_user_id,
    owner_kind: owner,
    required_upstream_queue_state: requiredQueue ?? null,
    status: "running" as StationStatus,
    started_at: new Date().toISOString(),
    upstream_station_id: upstream.upstream_station_id,
    upstream_run_id: upstream.upstream_run_id,
    input_batch_id: upstream.input_batch_id,
    dependency_failure: queueDependency ?? upstream.dependency_failure,
  };

  const { data, error } = await sb
    .from("daily_ops_station_runs")
    .insert(insert)
    .select()
    .single();
  if (error) {
    // Race: unique violation → re-read and resume
    if (String(error.message).includes("duplicate") || error.code === "23505") {
      const { data: raced } = await sb
        .from("daily_ops_station_runs")
        .select("*")
        .eq("station_id", stationId)
        .eq("business_date_ct", businessDate)
        .eq("run_key", runKey)
        .maybeSingle();
      if (raced) {
        return {
          status: 200,
          data: {
            ok: true,
            resumed: true,
            run: raced,
            dependency_failure: upstream.dependency_failure,
          },
        };
      }
    }
    return { status: 500, data: { error: error.message } };
  }
  return {
    status: 200,
    data: {
      ok: true,
      created: true,
      run: data,
      dependency_failure: upstream.dependency_failure,
      continue_safe_work: true,
    },
  };
}

export async function completeDailyStationRun(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  const clean = stripSpoofedAttribution(body);
  const runId = String(clean.run_id ?? clean.id ?? "").trim();
  if (!runId) return { status: 400, data: { error: "run_id required" } };

  const { data: existing, error: loadErr } = await sb
    .from("daily_ops_station_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (loadErr) return { status: 500, data: { error: loadErr.message } };
  if (!existing) return { status: 404, data: { error: "run not found" } };

  const stationId = String(existing.station_id);
  const completeDenied = authorizeStationOperator(stationId, ops.kind, "complete");
  if (completeDenied) {
    return { status: 403, data: { error: completeDenied, code: "station_ownership" } };
  }
  if (
    existing.owner_kind &&
    existing.owner_kind !== stationOwner(stationId) &&
    ops.kind !== "fendi"
  ) {
    return {
      status: 403,
      data: { error: `Cannot complete ${existing.owner_kind}-owned station run`, code: "station_ownership" },
    };
  }

  const statusRaw = String(clean.status ?? "completed").trim();
  const allowed: StationStatus[] = ["completed", "partial", "blocked", "failed"];
  if (!allowed.includes(statusRaw as StationStatus)) {
    return { status: 400, data: { error: `status must be one of ${allowed.join(", ")}` } };
  }

  const attr = attributionFrom(ops);
  const patch: Record<string, unknown> = {
    status: statusRaw,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Do not overwrite original actor_* — stamp completer separately.
    completed_by: attr.actor_kind,
    completed_by_label: attr.actor_label,
    raw_discoveries: asInt(clean.raw_discoveries),
    unique_discoveries: asInt(clean.unique_discoveries),
    verified_targets: asInt(clean.verified_targets),
    drafts_created: asInt(clean.drafts_created),
    duplicates: asInt(clean.duplicates),
    rejected_blocked: Array.isArray(clean.rejected_blocked) ? clean.rejected_blocked : [],
    saturation_indicators: Array.isArray(clean.saturation_indicators)
      ? clean.saturation_indicators
      : [],
    shortfall_reason: clean.shortfall_reason != null ? String(clean.shortfall_reason) : null,
    error_summary: clean.error_summary != null ? String(clean.error_summary) : null,
  };
  if (clean.output_batch_id != null) patch.output_batch_id = String(clean.output_batch_id);
  if (clean.input_batch_id != null) patch.input_batch_id = String(clean.input_batch_id);
  if (clean.dependency_failure != null) {
    patch.dependency_failure = String(clean.dependency_failure);
  }
  if (clean.metrics && typeof clean.metrics === "object") patch.metrics = clean.metrics;

  const { data, error } = await sb
    .from("daily_ops_station_runs")
    .update(patch)
    .eq("id", runId)
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, run: data } };
}

export async function listDailyStationRuns(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<RunResult> {
  const limit = Math.min(asInt(body.limit, 50), 200);
  let q = sb
    .from("daily_ops_station_runs")
    .select("*")
    .order("business_date_ct", { ascending: false })
    .order("started_at", { ascending: false })
    .limit(limit);
  if (typeof body.business_date_ct === "string") {
    q = q.eq("business_date_ct", body.business_date_ct);
  }
  if (typeof body.station_id === "string") {
    q = q.eq("station_id", body.station_id);
  }
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, rows: data ?? [], timezone: "America/Chicago" } };
}

export async function getDailyOpsDashboard(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<RunResult> {
  const businessDate =
    typeof body.business_date_ct === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.business_date_ct)
      ? body.business_date_ct
      : chicagoBusinessDate();

  const { data: runs, error } = await sb
    .from("daily_ops_station_runs")
    .select("*")
    .eq("business_date_ct", businessDate)
    .order("started_at", { ascending: true });
  if (error) return { status: 500, data: { error: error.message } };

  const { data: batches } = await sb
    .from("agh_handoff_batches")
    .select("id, batch_kind, queue_state, record_count, business_date_ct, created_at, updated_at")
    .eq("business_date_ct", businessDate)
    .order("created_at", { ascending: false })
    .limit(40);

  const { data: settings } = await sb.from("ops_settings").select("setting_key, setting_value, description");

  return {
    status: 200,
    data: {
      ok: true,
      timezone: "America/Chicago",
      business_date_ct: businessDate,
      stations: DAILY_STATION_IDS,
      runs: runs ?? [],
      handoff_batches: batches ?? [],
      settings: settings ?? [],
    },
  };
}

export async function listOpsSettings(sb: SupabaseClient): Promise<RunResult> {
  const { data, error } = await sb.from("ops_settings").select("*").order("setting_key");
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, rows: data ?? [] } };
}

export async function upsertOpsSetting(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  const key = String(body.setting_key ?? "").trim();
  if (!key) return { status: 400, data: { error: "setting_key required" } };
  if (body.setting_value === undefined) {
    return { status: 400, data: { error: "setting_value required" } };
  }
  const row = {
    setting_key: key,
    setting_value: body.setting_value,
    description: body.description != null ? String(body.description) : null,
    updated_by: ops.label,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from("ops_settings")
    .upsert(row, { onConflict: "setting_key" })
    .select()
    .single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, row: data } };
}

export async function runDailyOpsAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  actor: Actor | null,
  req: Request | null,
): Promise<RunResult> {
  const ops = resolveOpsActor(actor, req);
  switch (action) {
    case "start_daily_station_run":
      return startDailyStationRun(sb, body, actor, req);
    case "complete_daily_station_run":
      return completeDailyStationRun(sb, body, actor, req);
    case "list_daily_station_runs":
      return listDailyStationRuns(sb, body);
    case "get_daily_station_run": {
      const id = String(body.run_id ?? body.id ?? "").trim();
      if (!id) return { status: 400, data: { error: "run_id required" } };
      const { data, error } = await sb.from("daily_ops_station_runs").select("*").eq("id", id).maybeSingle();
      if (error) return { status: 500, data: { error: error.message } };
      if (!data) return { status: 404, data: { error: "run not found" } };
      return { status: 200, data: { ok: true, run: data } };
    }
    case "get_daily_ops_dashboard":
      return getDailyOpsDashboard(sb, body);
    case "list_ops_settings":
      return listOpsSettings(sb);
    case "upsert_ops_setting":
      return upsertOpsSetting(sb, stripSpoofedAttribution(body), ops);
    default:
      return { status: 400, data: { error: `Unknown daily ops action: ${action}` } };
  }
}
