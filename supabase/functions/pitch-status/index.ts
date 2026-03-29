import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key" };
function getHubKey(req: Request): string {
  return (req.headers.get("x-api-key") || req.headers.get("apikey") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const trackName = typeof body.track_name === "string" ? body.track_name.trim() : "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let q = sb.from("pitch_log").select("*").order("pitched_at", { ascending: false }).limit(50);
    if (trackName) q = q.ilike("track_name", "%" + trackName + "%");
    const { data: rows, error } = await q;
    if (error) return json({ error: error.message }, 500);
    const { count: email24 } = await sb.from("pitch_log").select("*", { count: "exact", head: true })
      .eq("method", "email").eq("status", "sent").gte("pitched_at", new Date(Date.now() - 86400000).toISOString());
    return json({ ok: true, entries: rows ?? [], summary: { email_pitches_last_24h: typeof email24 === "number" ? email24 : 0 } });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
});
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
