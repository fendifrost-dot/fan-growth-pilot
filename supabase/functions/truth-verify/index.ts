import { createSupabaseServiceClient } from "../_shared/truth/supabaseService.ts";
import { ingestTruthEvent } from "../_shared/truth/truthIngest.ts";
import { runFullFunnelVerify } from "../_shared/truth/truthFunnelVerify.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-truth-verify-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function verifyAuth(req: Request): boolean {
  const secret = Deno.env.get("TRUTH_VERIFY_SECRET");
  const url = new URL(req.url);
  const provided =
    req.headers.get("x-truth-verify-secret") ||
    req.headers.get("x-api-key") ||
    url.searchParams.get("secret");
  return Boolean(secret && provided === secret);
}

type CapiInfo = { attempted: boolean; httpStatus: number | null; ok: boolean | null };

function capiExpectsMetaDispatch(eventType: string): boolean {
  const t = eventType.toLowerCase();
  return t === "link_click" || t === "email_submit" || t === "purchase";
}

function verifyMetaFields(
  eventType: string,
  c: CapiInfo | undefined
): { meta_attempted: boolean; meta_status: "success" | "fail" } {
  if (!capiExpectsMetaDispatch(eventType)) {
    return { meta_attempted: false, meta_status: "success" };
  }
  if (!c?.attempted) {
    return { meta_attempted: false, meta_status: "fail" };
  }
  if (c.ok === true) {
    return { meta_attempted: true, meta_status: "success" };
  }
  return { meta_attempted: true, meta_status: "fail" };
}

async function capiMapForEventIds(
  sb: SupabaseClient,
  eventIds: string[]
): Promise<Map<string, CapiInfo>> {
  const out = new Map<string, CapiInfo>();
  if (!eventIds.length) return out;

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data: rows } = await sb
    .from("system_logs")
    .select("metadata, message, created_at")
    .eq("process_name", "capi:response")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  for (const r of rows ?? []) {
    const meta = (r.metadata as Record<string, unknown>) || {};
    const eid = meta.eventId as string | undefined;
    if (!eid || !eventIds.includes(eid) || out.has(eid)) continue;

    const httpStatus = typeof meta.httpStatus === "number" ? meta.httpStatus : null;
    let ok: boolean | null = httpStatus != null ? httpStatus >= 200 && httpStatus < 300 : null;
    if (ok === null && r.message) {
      try {
        const parsed = JSON.parse(r.message as string) as Record<string, unknown>;
        if (typeof parsed.error === "string") ok = false;
        else if (parsed.events_received !== undefined) ok = true;
      } catch {
        ok = null;
      }
    }
    out.set(eid, { attempted: true, httpStatus, ok });
  }

  const { data: reqRows } = await sb
    .from("system_logs")
    .select("metadata")
    .eq("process_name", "capi:request")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);

  for (const r of reqRows ?? []) {
    const meta = (r.metadata as Record<string, unknown>) || {};
    const eid = meta.event_id as string | undefined;
    if (!eid || !eventIds.includes(eid)) continue;
    if (!out.has(eid)) out.set(eid, { attempted: true, httpStatus: null, ok: null });
  }

  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!verifyAuth(req)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const sb = createSupabaseServiceClient();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 12));

    const { data: fe } = await sb
      .from("fan_events")
      .select("id, event_type, fan_profile_id, occurred_at, metadata, event_source")
      .order("occurred_at", { ascending: false })
      .limit(limit);

    const { data: la } = await sb
      .from("link_analytics")
      .select("id, link_id, clicked_at, converted, metadata")
      .order("clicked_at", { ascending: false })
      .limit(limit);

    const ids = [
      ...(fe ?? []).map((r) => r.id as string),
      ...(la ?? []).map((r) => r.id as string),
    ];
    const capi = await capiMapForEventIds(sb, ids);

    const fanEventChecks = await Promise.all(
      (fe ?? []).map(async (r) => {
        const c = capi.get(r.id as string);
        const meta = verifyMetaFields(String(r.event_type), c);
        return {
          event_type: r.event_type,
          db_write: true,
          fan_profile_linked: Boolean(r.fan_profile_id),
          meta_attempted: meta.meta_attempted,
          meta_status: meta.meta_status,
          link_analytics_row: false,
          timestamp: r.occurred_at,
        };
      })
    );

    const linkChecks = (la ?? []).map((r) => {
      const c = capi.get(r.id as string);
      const meta = verifyMetaFields("link_click", c);
      return {
        event_type: "link_click" as const,
        db_write: true,
        fan_profile_linked: false,
        meta_attempted: meta.meta_attempted,
        meta_status: meta.meta_status,
        link_analytics_row: true,
        timestamp: r.clicked_at,
      };
    });

    const merged = [...fanEventChecks, ...linkChecks].sort((a, b) => {
      const ta = new Date(a.timestamp as string).getTime();
      const tb = new Date(b.timestamp as string).getTime();
      return tb - ta;
    });

    return json({
      ok: true,
      generated_at: new Date().toISOString(),
      limit,
      recent: merged.slice(0, limit),
    });
  }

  if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const url = new URL(req.url);
    const mode = String(body.mode ?? url.searchParams.get("mode") ?? "smoke");

    if (mode === "full") {
      const sb = createSupabaseServiceClient();
      const requireCapi =
        body.requireCapi === true || url.searchParams.get("requireCapi") === "1";
      const smartLinkId =
        (body.smartLinkId as string) || url.searchParams.get("smartLinkId") || undefined;
      const report = await runFullFunnelVerify(sb, {
        smartLinkId: smartLinkId ?? null,
        requireCapi,
      });
      return json(report, report.ok ? 200 : 503);
    }

    const sb = createSupabaseServiceClient();
    const report: Record<string, unknown> = {
      ok: true,
      steps: [] as object[],
    };
    const steps = report.steps as object[];

    const testEmail = `truth-verify+${Date.now()}@example.invalid`;
    const deviceId = `verify-device-${Date.now()}`;

    const verifyTs = new Date().toISOString();
    const verifySession = `verify-${Date.now()}`;
    steps.push({ step: "simulate_ingest", payload: { event_type: "link_click", testEmail } });

    const ingestResult = await ingestTruthEvent(
      {
        event_type: "link_click",
        event_time: verifyTs,
        smartLinkId: null,
        fan_profile_id: null,
        source: "verification",
        platform: "spotify",
        identity_fields: {
          email: testEmail,
          phone: null,
          device_id: deviceId,
          meta_fbp: "fb.1.verify.fbp",
          meta_fbc: "fb.1.verify.fbc",
        },
        metadata: {
          campaign: null,
          source: "verification",
          medium: null,
          referrer: null,
          session_id: verifySession,
          anonymous_id: verifySession,
          click_id: null,
          orderId: null,
          value: null,
          currency: null,
        },
      },
      { awaitCapi: true, supabase: sb }
    );

    steps.push({ step: "ingest_result", result: ingestResult });

    let eventRow: { id: string; event_type?: string; fan_profile_id?: string | null } | null = null;
    let eventSource: "fan_events" | "link_analytics" | null = null;

    const fe = await sb
      .from("fan_events")
      .select("id, event_type, fan_profile_id")
      .eq("id", ingestResult.eventId)
      .maybeSingle();
    if (fe.data) {
      eventRow = fe.data;
      eventSource = "fan_events";
    } else {
      const la = await sb
        .from("link_analytics")
        .select("id, link_id")
        .eq("id", ingestResult.eventId)
        .maybeSingle();
      if (la.data) {
        eventRow = { id: la.data.id as string, event_type: "link_click", fan_profile_id: null };
        eventSource = "link_analytics";
      }
    }

    steps.push({
      step: "db_event_exists",
      ok: Boolean(eventRow),
      event_id: ingestResult.eventId,
      table: eventSource,
    });

    let profileOk = false;
    if (ingestResult.identityId) {
      const { data: prof, error: pErr } = await sb
        .from("fan_profiles")
        .select("id, email")
        .eq("id", ingestResult.identityId)
        .maybeSingle();
      profileOk = Boolean(prof && !pErr);
      steps.push({
        step: "fan_profile_exists",
        ok: profileOk,
        identity_id: ingestResult.identityId,
        error: pErr?.message,
      });
    } else {
      steps.push({ step: "fan_profile_exists", ok: false, note: "no identity_id returned" });
    }

    const since = new Date(Date.now() - 120_000).toISOString();
    const { data: logs } = await sb
      .from("system_logs")
      .select("process_name, created_at")
      .in("process_name", ["capi:request", "capi:response", "capi:skipped", "capi:fetch_error"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(30);

    const hadRequest = logs?.some((l) => l.process_name === "capi:request");
    const hadResponse = logs?.some((l) => l.process_name === "capi:response");

    steps.push({
      step: "system_logs_capi",
      had_request_log: hadRequest,
      had_response_log: hadResponse,
      capi_from_ingest: ingestResult.capi ?? null,
    });

    const capiFired = ingestResult.capi?.ok === true;
    const checks = {
      event_created: Boolean(eventRow && eventSource),
      identity_linked: profileOk,
      capi_fired: capiFired,
      capi_skipped_reason: ingestResult.capi?.skipped ?? null,
      capi_http_status: ingestResult.capi?.status ?? null,
    };

    report.checks = checks;
    report.ok = checks.event_created && checks.identity_linked && checks.capi_fired;

    return json(report, report.ok ? 200 : 503);
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
});
