/**
 * Fan Instagram engagement — followers who follow you, not playlist curators.
 * Manual send default; optional Graph API when token + ig_user_id are set.
 */
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  FAN_DM_STAGE_ORDER,
  pickDailyTemplate,
  type FanDmStage,
} from "./fan-dm-templates.ts";
import { personalizeFanDm } from "./fan-dm-personalize.ts";

export const FAN_IG_DAILY_CAP = 10;

export type RunResult = { status: number; data: Record<string, unknown> };

const FAN_ACTIONS = new Set([
  "list_fan_roster",
  "patch_fan_roster",
  "import_fan_roster",
  "queue_fan_dm_batch",
  "list_fan_dm_queue",
  "update_fan_dm_draft",
  "mark_fan_dm_sent",
  "get_instagram_messaging_status",
  "send_fan_dm_via_api",
]);

export function isFanEngagementAction(action: string): boolean {
  return FAN_ACTIONS.has(action);
}

function utcDayStart(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function countFanDmsToday(sb: SupabaseClient): Promise<number> {
  const { count } = await sb.from("fan_engagement_queue")
    .select("*", { count: "exact", head: true })
    .in("status", ["pending", "sent"])
    .gte("created_at", utcDayStart());
  return count ?? 0;
}

async function nextFanDmRef(sb: SupabaseClient): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const { count } = await sb.from("fan_engagement_queue")
    .select("*", { count: "exact", head: true })
    .gte("created_at", utcDayStart());
  const n = String((count ?? 0) + 1).padStart(3, "0");
  return `FF-FAN-${day}-${n}`;
}

function buildOperatorBrief(
  fan: { ig_handle: string; display_name?: string | null; dm_stage?: string },
  stage: FanDmStage,
  dmRef: string,
  method: string,
  templateSlug: string,
): string {
  return [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "FAN FUEL · FAN DM (operator)",
    `REF: ${dmRef}`,
    `DATE: ${new Date().toISOString().slice(0, 10)} UTC`,
    "",
    "IDENTITY",
    `  Instagram:  @${fan.ig_handle}`,
    `  Name:       ${fan.display_name ?? "(not set)"}`,
    `  Stage:      ${stage} (roster: ${fan.dm_stage ?? "opener"})`,
    "",
    "MESSAGE",
    `  Template:   ${templateSlug} (same for everyone today UTC)`,
    `  Personalized: ${method}`,
    "",
    "PASTE RULE",
    "  Copy the MESSAGE TO SEND block only — never paste this brief into IG.",
    "  Open & copy → paste in IG → edit if needed → send → Mark sent.",
    "",
    "LATER STAGES",
    "  opener → runway (Runway Music) → invite (soft email list)",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}

function igDmUrl(handle: string): string {
  const h = handle.replace(/^@/, "").trim();
  return `https://ig.me/m/${encodeURIComponent(h)}`;
}

export async function runFanEngagementAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  switch (action) {
    case "list_fan_roster":
      return listFanRoster(sb, body);
    case "patch_fan_roster":
      return patchFanRoster(sb, body);
    case "import_fan_roster":
      return importFanRoster(sb, body);
    case "queue_fan_dm_batch":
      return queueFanDmBatch(sb, body);
    case "list_fan_dm_queue":
      return listFanDmQueue(sb, body);
    case "update_fan_dm_draft":
      return updateFanDmDraft(sb, body);
    case "mark_fan_dm_sent":
      return markFanDmSent(sb, body);
    case "get_instagram_messaging_status":
      return getInstagramMessagingStatus();
    case "send_fan_dm_via_api":
      return sendFanDmViaApi(sb, body);
    default:
      return { status: 400, data: { error: `Unknown fan action: ${action}` } };
  }
}

async function listFanRoster(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  let q = sb.from("instagram_fan_roster").select("*").order("updated_at", { ascending: false }).limit(500);
  if (body.follows_me_only) q = q.eq("follows_me", true);
  if (body.exclude_dnc) q = q.eq("do_not_contact", false);
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, rows: data ?? [] } };
}

async function patchFanRoster(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const handle = String(body.ig_handle ?? "").replace(/^@/, "").trim().toLowerCase();
  if (!handle) return { status: 400, data: { error: "ig_handle required" } };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.display_name !== undefined) patch.display_name = String(body.display_name ?? "").trim() || null;
  if (body.follows_me !== undefined) patch.follows_me = Boolean(body.follows_me);
  if (body.i_follow !== undefined) patch.i_follow = Boolean(body.i_follow);
  if (body.ig_user_id !== undefined) patch.ig_user_id = String(body.ig_user_id ?? "").trim() || null;
  if (body.do_not_contact !== undefined) patch.do_not_contact = Boolean(body.do_not_contact);
  if (body.relationship_notes !== undefined) {
    patch.relationship_notes = String(body.relationship_notes ?? "").trim() || null;
  }
  if (body.dm_stage !== undefined) {
    const s = String(body.dm_stage ?? "").trim() as FanDmStage;
    if (!FAN_DM_STAGE_ORDER.includes(s)) {
      return { status: 400, data: { error: "invalid dm_stage", allowed: FAN_DM_STAGE_ORDER } };
    }
    patch.dm_stage = s;
  }
  const { error } = await sb.from("instagram_fan_roster").upsert(
    { ig_handle: handle, ...patch },
    { onConflict: "ig_handle" },
  );
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, ig_handle: handle } };
}

async function importFanRoster(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return { status: 400, data: { error: "entries[] required" } };
  const rows = entries.map((e: Record<string, unknown>) => ({
    ig_handle: String(e.ig_handle ?? "").replace(/^@/, "").trim().toLowerCase(),
    display_name: e.display_name ? String(e.display_name).trim() : null,
    follows_me: e.follows_me !== false,
    i_follow: Boolean(e.i_follow),
    relationship_notes: e.notes ? String(e.notes) : null,
    updated_at: new Date().toISOString(),
  })).filter((r) => r.ig_handle);
  const { error } = await sb.from("instagram_fan_roster").upsert(rows, { onConflict: "ig_handle" });
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, imported: rows.length } };
}

async function queueFanDmBatch(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const limit = Math.min(FAN_IG_DAILY_CAP, Math.max(1, Number(body.limit) || FAN_IG_DAILY_CAP));
  const queuedToday = await countFanDmsToday(sb);
  const remaining = Math.max(0, FAN_IG_DAILY_CAP - queuedToday);
  if (remaining <= 0) {
    return {
      status: 429,
      data: {
        error: `Fan IG daily cap reached (${FAN_IG_DAILY_CAP}/day UTC)`,
        cap: FAN_IG_DAILY_CAP,
        queued_today: queuedToday,
      },
    };
  }
  const batchSize = Math.min(limit, remaining);

  const { data: fans, error: fanErr } = await sb.from("instagram_fan_roster")
    .select("*")
    .eq("follows_me", true)
    .eq("do_not_contact", false)
    .order("last_contacted_at", { ascending: true, nullsFirst: true })
    .limit(batchSize * 3);
  if (fanErr) return { status: 500, data: { error: fanErr.message } };

  const queued: string[] = [];
  const skipped: { handle: string; reason: string }[] = [];

  for (const fan of fans ?? []) {
    if (queued.length >= batchSize) break;
    const handle = fan.ig_handle as string;

    const { data: pending } = await sb.from("fan_engagement_queue")
      .select("id")
      .eq("ig_handle", handle)
      .eq("status", "pending")
      .maybeSingle();
    if (pending?.id) {
      skipped.push({ handle, reason: "already_pending" });
      continue;
    }

    const stage = (fan.dm_stage as FanDmStage) || "opener";
    if (!FAN_DM_STAGE_ORDER.includes(stage)) {
      skipped.push({ handle, reason: "invalid_stage" });
      continue;
    }

    const { slug, body: templateBody } = pickDailyTemplate(stage);
    const { message, method } = await personalizeFanDm(templateBody, {
      ig_handle: handle,
      display_name: fan.display_name as string | null,
    }, stage);
    const dmRef = await nextFanDmRef(sb);
    const brief = buildOperatorBrief(fan, stage, dmRef, method, slug);

    const { error: insErr } = await sb.from("fan_engagement_queue").insert({
      ig_handle: handle,
      stage,
      template_slug: slug,
      template_body: templateBody,
      draft_text: message,
      operator_brief: brief,
      dm_ref: dmRef,
      status: "pending",
      personalization_method: method,
    });
    if (insErr) {
      skipped.push({ handle, reason: insErr.message });
      continue;
    }
    queued.push(handle);
  }

  return {
    status: 200,
    data: {
      ok: true,
      queued: queued.length,
      handles: queued,
      skipped,
      cap: FAN_IG_DAILY_CAP,
      queued_today: queuedToday + queued.length,
      remaining: Math.max(0, remaining - queued.length),
      daily_templates: FAN_DM_STAGE_ORDER.map((s) => ({ stage: s, ...pickDailyTemplate(s) })),
    },
  };
}

async function listFanDmQueue(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const status = String(body.status ?? "pending").trim() || "pending";
  const lim = Math.min(50, Math.max(1, Number(body.limit) || 30));
  let q = sb.from("fan_engagement_queue")
    .select("*, instagram_fan_roster(display_name, ig_user_id, dm_stage)")
    .order("created_at", { ascending: true })
    .limit(lim);
  if (status !== "all") q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  const queuedToday = await countFanDmsToday(sb);
  return {
    status: 200,
    data: {
      ok: true,
      rows: data ?? [],
      fan_dm_cap: FAN_IG_DAILY_CAP,
      fan_dm_queued_today: queuedToday,
      fan_dm_remaining: Math.max(0, FAN_IG_DAILY_CAP - queuedToday),
      ig_dm_url_pattern: "https://ig.me/m/{handle}",
    },
  };
}

async function updateFanDmDraft(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const id = String(body.queue_id ?? "").trim();
  const draftText = String(body.draft_text ?? "").trim();
  if (!id || !draftText) return { status: 400, data: { error: "queue_id and draft_text required" } };
  const { error } = await sb.from("fan_engagement_queue")
    .update({ draft_text: draftText })
    .eq("id", id)
    .eq("status", "pending");
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true } };
}

async function markFanDmSent(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const id = String(body.queue_id ?? "").trim();
  if (!id) return { status: 400, data: { error: "queue_id required" } };
  const now = new Date().toISOString();
  const { data: row, error: fetchErr } = await sb.from("fan_engagement_queue")
    .select("ig_handle, stage")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr || !row) return { status: 404, data: { error: "Queue row not found" } };

  const { error } = await sb.from("fan_engagement_queue").update({
    status: "sent",
    performed_at: now,
    performed_by: String(body.performed_by ?? "admin:fan-ig-queue"),
  }).eq("id", id);
  if (error) return { status: 500, data: { error: error.message } };

  const stage = row.stage as FanDmStage;
  const nextStage = stage === "opener" ? "runway" : stage === "runway" ? "invite" : "invite";
  await sb.from("instagram_fan_roster").update({
    last_contacted_at: now,
    dm_stage: nextStage,
    updated_at: now,
  }).eq("ig_handle", row.ig_handle);

  return { status: 200, data: { ok: true, next_stage: nextStage } };
}

async function getInstagramMessagingStatus(): Promise<RunResult> {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/functions/v1/instagram-messaging?action=status`);
    const data = await res.json().catch(() => ({}));
    return { status: res.ok ? 200 : 503, data: { ok: res.ok, ...data as Record<string, unknown> } };
  } catch (e) {
    return { status: 503, data: { ok: false, error: String(e) } };
  }
}

async function sendFanDmViaApi(sb: SupabaseClient, body: Record<string, unknown>): Promise<RunResult> {
  const id = String(body.queue_id ?? "").trim();
  const message = String(body.draft_text ?? "").trim();
  if (!id) return { status: 400, data: { error: "queue_id required" } };

  const { data: row, error } = await sb.from("fan_engagement_queue")
    .select("*, instagram_fan_roster(ig_user_id, ig_handle)")
    .eq("id", id)
    .maybeSingle();
  if (error || !row) return { status: 404, data: { error: "Queue row not found" } };

  const roster = row.instagram_fan_roster as { ig_user_id?: string; ig_handle?: string } | null;
  const recipientId = String(body.recipient_id ?? roster?.ig_user_id ?? "").trim();
  if (!recipientId) {
    return {
      status: 400,
      data: {
        error: "ig_user_id required for API send — use Open & copy, or set ig_user_id on fan roster",
        ig_handle: roster?.ig_handle ?? row.ig_handle,
        ig_dm_url: igDmUrl(String(row.ig_handle)),
      },
    };
  }

  const text = message || String(row.draft_text ?? "").trim();
  if (!text) return { status: 400, data: { error: "draft_text required" } };

  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  const res = await fetch(`${base}/functions/v1/instagram-messaging`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: recipientId, message: text }),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    return {
      status: res.status >= 400 ? res.status : 502,
      data: { ok: false, error: "Instagram API send failed", details: data },
    };
  }

  if (body.mark_sent !== false) {
    await markFanDmSent(sb, { queue_id: id, performed_by: "admin:api_send" });
  }

  return { status: 200, data: { ok: true, sent: true, api: data } };
}
