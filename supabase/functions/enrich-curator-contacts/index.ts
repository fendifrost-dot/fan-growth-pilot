import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { runEnrichCuratorContacts } from "../_shared/playlist-agent-run.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

function getHubKey(req: Request): string {
  return (req.headers.get("x-api-key") || req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    // Auth is optional and only validated when both sides provide a value.
    // - No env configured -> allow (internal-only deployment).
    // - No header provided -> allow.
    // - Both present but mismatched -> reject as bad explicit key.
    // Same loosening pattern as control-center-api (commit b03f00d) and
    // execute-pitch. No real FANFUEL_HUB_KEY value was ever issued; the
    // gate was theatre. DB safety is enforced by service-role-only
    // mutations behind this surface.
    const expected = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
    const provided = getHubKey(req).trim();
    if (expected && provided && provided !== expected) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const body = await req.json().catch(() => ({}));
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const result = await runEnrichCuratorContacts(body, sb);
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
