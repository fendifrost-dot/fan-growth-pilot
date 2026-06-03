import { createSupabaseServiceClient } from "../_shared/truth/supabaseService.ts";
import {
  fetchDashboardMetrics,
  fetchAudienceSegments,
} from "../_shared/truth/dashboardMetrics.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-truth-verify-secret",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!verifyAuth(req)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "dashboard";
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30));

  try {
    const sb = createSupabaseServiceClient();
    if (mode === "segments") {
      const segments = await fetchAudienceSegments(sb);
      return json({ ok: true, segments });
    }
    const metrics = await fetchDashboardMetrics(sb, days);
    return json({ ok: true, ...metrics });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: message }, 500);
  }
});
