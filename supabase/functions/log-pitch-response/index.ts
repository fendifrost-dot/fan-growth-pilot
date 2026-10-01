// Token-free curator-response logging for routines (Gmail reply digest etc.).
// Auth: dedicated secret PITCH_RESPONSE_LOG_KEY in the x-pitch-log-key HEADER only —
// never a user session JWT, never a query string. Writes pitch_log response fields only,
// through the attributed agh_update_pitch_response RPC. Sends nothing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { logPitchResponse, safeEqual } from "../_shared/pitch-response-log.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-pitch-log-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  if (new URL(req.url).search) return json({ ok: false, error: "query strings are not accepted; send JSON in the body" }, 400);

  const expected = Deno.env.get("PITCH_RESPONSE_LOG_KEY") ?? "";
  if (expected.length < 24) return json({ ok: false, code: "not_configured", error: "PITCH_RESPONSE_LOG_KEY is not set" }, 503);
  const given = (req.headers.get("x-pitch-log-key") ?? "").trim();
  if (!given || !safeEqual(given, expected.trim())) return json({ ok: false, error: "Unauthorized" }, 401);

  const raw = await req.text();
  if (raw.length > 8000) return json({ ok: false, error: "body too large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "JSON object required" }, 400);

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const res = await logPitchResponse(sb, body);
    return json(res.data, res.status);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
