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
    const trackName = String(body.track_name || "").trim();
    const status = String(body.status || "").trim().toLowerCase();
    let playlistId = typeof body.playlist_id === "string" ? body.playlist_id.trim() : "";
    const playlistName = typeof body.playlist_name === "string" ? body.playlist_name.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    if (!trackName) return json({ ok: false, message_to_user: "Missing track_name." }, 400);
    if (status !== "responded" && status !== "rejected") return json({ ok: false, message_to_user: "status must be responded or rejected." }, 400);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (!playlistId && playlistName) {
      const { data: pl } = await sb.from("playlist_targets").select("playlist_id")
        .or("playlist_name.ilike.%" + playlistName + "%,curator_name.ilike.%" + playlistName + "%").limit(5);
      if (pl && pl.length === 1) playlistId = pl[0].playlist_id;
      else if (pl && pl.length > 1) return json({ ok: false, message_to_user: "Multiple playlists match \"" + playlistName + "\". Use a more specific name." });
    }
    if (!playlistId) return json({ ok: false, message_to_user: "Could not resolve playlist. Include playlist name from your last report." });
    const { data: row } = await sb.from("pitch_log").select("id").eq("playlist_id", playlistId).eq("track_name", trackName).eq("status", "sent").order("pitched_at", { ascending: false }).limit(1).maybeSingle();
    if (!row?.id) return json({ ok: false, message_to_user: "No sent pitch found for this track x playlist." });
    const { error: upErr } = await sb.from("pitch_log").update({ status, response_notes: notes || null }).eq("id", row.id);
    if (upErr) return json({ ok: false, message_to_user: upErr.message }, 500);
    return json({ ok: true, message_to_user: status === "responded" ? "✅ Marked *responded* for playlist *" + playlistId + "* (" + trackName + ")." : "✅ Marked *rejected* for playlist *" + playlistId + "* (" + trackName + ")." });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
});
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
