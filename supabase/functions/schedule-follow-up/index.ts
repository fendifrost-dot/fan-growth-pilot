import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { runScheduleFollowUp } from "../_shared/playlist-agent-run.ts";

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
    const expected = Deno.env.get("FANFUEL_HUB_KEY")!;
    if (!expected || getHubKey(req).trim() !== expected.trim()) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const body = await req.json().catch(() => ({}));
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const result = await runScheduleFollowUp(body, sb, expected);
    return new Response(JSON.stringify(result.data), { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
