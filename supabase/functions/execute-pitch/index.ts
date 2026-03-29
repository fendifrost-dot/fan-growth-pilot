import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};
const NON_BULK_METHODS = new Set(["algorithmic", "distributor_pitch"]);
function getHubKey(req: Request): string {
  return (req.headers.get("x-api-key") || req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
}
type PitchResponse = {
  ok: boolean; method_used: string;
  action_taken: "email_sent"|"instructions_only"|"link_delivered"|"skipped"|"tier_gate"|"error";
  cooldown_until: string|null; message_to_user: string;
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlist_id || "").trim();
    const trackName = String(body.track_name || "").trim();
    const methodOverride = typeof body.method_override === "string" ? body.method_override.trim() : "";
    const tierConfirmed = Boolean(body.tier_confirmed);
    const bulk = Boolean(body.bulk);
    if (!playlistId || !trackName) return jsonPitch({ ok:false, method_used:"none", action_taken:"error", cooldown_until:null, message_to_user:"Missing playlist_id or track_name." });
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, key);
    const { data: row, error: rowErr } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (rowErr || !row) return jsonPitch({ ok:false, method_used:"none", action_taken:"error", cooldown_until:null, message_to_user:"Playlist not found: " + playlistId });
    const method = (methodOverride || row.submission_method || "other").toLowerCase().trim();
    if (bulk && NON_BULK_METHODS.has(method)) return jsonPitch({ ok:true, method_used:method, action_taken:"skipped", cooldown_until:null, message_to_user:"⏭️ Skipped *" + (row.playlist_name ?? playlistId) + "* — method *" + method + "* needs a manual pass." });
    const tierRaw = row.tier;
    const tier = typeof tierRaw === "number" ? tierRaw : tierRaw != null && tierRaw !== "" ? Number(tierRaw) : null;
    if (tier === 3 && !tierConfirmed) return jsonPitch({ ok:false, method_used:method, action_taken:"tier_gate", cooldown_until:null, message_to_user:"⚠️ *Tier 3 playlist* — *" + (row.playlist_name ?? playlistId) + "*\n\nFlagged for verify-first pitching. Reply *confirm* to send." });
    if (method === "email") return await handleEmailPitch(sb, row, trackName, bulk);
    return jsonPitch(buildNonEmailMessage(row, method, trackName));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonPitch({ ok:false, method_used:"error", action_taken:"error", cooldown_until:null, message_to_user:"❌ " + msg });
  }
});
function jsonPitch(p: PitchResponse, status = 200) {
  return new Response(JSON.stringify(p), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
async function getCooldownDays(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "cooldown_days").maybeSingle();
  if (!data?.value) return 90;
  const n = typeof data.value === "number" ? data.value : Number(data.value);
  return Number.isFinite(n) && n > 0 ? n : 90;
}
async function getArtistConfig(sb: SupabaseClient): Promise<{ artistId: string; trackUrls: Record<string, string> }> {
  const { data: rows } = await sb.from("artist_config").select("key, value").in("key", ["spotify_artist_id", "spotify_track_urls"]);
  let artistId = "";
  const trackUrls: Record<string, string> = {};
  for (const r of rows ?? []) {
    if (r.key === "spotify_artist_id") artistId = typeof r.value === "string" ? r.value : String(r.value ?? "").replace(/^"|"$/g, "");
    if (r.key === "spotify_track_urls" && r.value && typeof r.value === "object" && !Array.isArray(r.value)) Object.assign(trackUrls, r.value as Record<string, string>);
  }
  return { artistId, trackUrls };
}
async function handleEmailPitch(sb: SupabaseClient, row: Record<string, unknown>, trackName: string, _bulk: boolean): Promise<Response> {
  const playlistId = String(row.playlist_id);
  const email = (row.curator_email as string|null)?.trim();
  const playlistName = (row.playlist_name as string|null) ?? playlistId;
  const method = "email";
  if (!email) return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"No curator email on file for *" + playlistName + "*." });
  const { data: existing } = await sb.from("pitch_log").select("id, cooldown_until").eq("playlist_id", playlistId).eq("track_name", trackName).eq("status", "sent").gt("cooldown_until", new Date().toISOString()).maybeSingle();
  if (existing?.id) {
    const until = existing.cooldown_until ? new Date(existing.cooldown_until as string).toLocaleDateString() : "?";
    return jsonPitch({ ok:false, method_used:method, action_taken:"skipped", cooldown_until:existing.cooldown_until as string, message_to_user:"⏳ Already pitched *" + playlistName + "* for *" + trackName + "*. Cooldown until *" + until + "*." });
  }
  const { count: capCount } = await sb.from("pitch_log").select("*", { count:"exact", head:true }).eq("method", "email").eq("status", "sent").gte("pitched_at", new Date(Date.now() - 86400000).toISOString());
  if ((capCount ?? 0) >= 10) return jsonPitch({ ok:false, method_used:method, action_taken:"skipped", cooldown_until:null, message_to_user:"📧 Daily email pitch cap reached (10 per 24h). Try again tomorrow." });
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = (Deno.env.get("FROM_EMAIL") ?? "Fendi Frost <submissions@fendifrost.com>").trim();
  const { artistId, trackUrls } = await getArtistConfig(sb);
  const trackUrl = trackUrls[trackName] || trackUrls[trackName.toLowerCase()] || "https://open.spotify.com/artist/" + (artistId || "0000000000000000000000");
  const cooldownDays = await getCooldownDays(sb);
  const cooldownIso = new Date(Date.now() + cooldownDays * 86400000).toISOString();
  const bodyHtml = ["<p>Hi,</p>","<p>I'm reaching out to submit <strong>" + escapeHtml(trackName) + "</strong> by <strong>Fendi Frost</strong> for playlist consideration.</p>","<p>Listen: <a href=\"" + escapeHtml(trackUrl) + "\">" + escapeHtml(trackUrl) + "</a></p>",artistId ? "<p>Artist on Spotify: <a href=\"https://open.spotify.com/artist/" + escapeHtml(artistId) + "\">profile</a></p>" : "","<p>Thank you for your time.</p>","<p>— Fendi Frost team</p>"].filter(Boolean).join("\n");
  if (!resendKey) {
    await sb.from("pitch_log").insert({ playlist_id:playlistId, track_name:trackName, pitched_at:new Date().toISOString(), method, status:"error", response_notes:"RESEND_API_KEY not configured", cooldown_until:null });
    return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"❌ Email not sent (Hub missing RESEND_API_KEY)." });
  }
  const res = await fetch("https://api.resend.com/emails", { method:"POST", headers: { Authorization:"Bearer " + resendKey, "Content-Type":"application/json" }, body: JSON.stringify({ from:fromEmail, to:[email], subject:"Submission: " + trackName + " — Fendi Frost", html:bodyHtml }) });
  const raw = await res.text();
  if (!res.ok) {
    await sb.from("pitch_log").insert({ playlist_id:playlistId, track_name:trackName, pitched_at:new Date().toISOString(), method, status:"error", response_notes:"Resend " + res.status + ": " + raw.slice(0,500), cooldown_until:null });
    return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"❌ Email failed (" + res.status + "). No cooldown applied — retry after fixing." });
  }
  const { error: insOk } = await sb.from("pitch_log").insert({ playlist_id:playlistId, track_name:trackName, pitched_at:new Date().toISOString(), method, status:"sent", cooldown_until:cooldownIso });
  if (insOk) return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"❌ Email sent but logging failed: " + insOk.message });
  return jsonPitch({ ok:true, method_used:method, action_taken:"email_sent", cooldown_until:cooldownIso, message_to_user:"📧 Pitch email sent to *" + email + "* for *" + playlistName + "* (" + trackName + "). Cooldown until " + new Date(cooldownIso).toLocaleDateString() + "." });
}
function escapeHtml(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function buildNonEmailMessage(row: Record<string, unknown>, method: string, trackName: string): PitchResponse {
  const playlistId = String(row.playlist_id);
  const playlistName = (row.playlist_name as string|null) ?? playlistId;
  const subUrl = (row.submission_url as string|null)?.trim() ?? "";
  const curator = (row.curator_name as string|null)?.trim() ?? "";
  if (method === "submithub") {
    if (!subUrl) return { ok:true, method_used:method, action_taken:"instructions_only", cooldown_until:null, message_to_user:"🔍 Find on SubmitHub: search '" + (curator||playlistName) + "'" };
    return { ok:true, method_used:method, action_taken:"link_delivered", cooldown_until:null, message_to_user:"🎯 SubmitHub: *" + playlistName + "*\n" + subUrl + "\nTrack: *" + trackName + "*" };
  }
  if (["web_form","google_form","dailyplaylists","indiemono","soundplate","playlistpartner"].includes(method) && subUrl) {
    return { ok:true, method_used:method, action_taken:"link_delivered", cooldown_until:null, message_to_user:"📝 Submit form for *" + playlistName + "*:\n" + subUrl + "\nPitch *" + trackName + "* there." };
  }
  if (method === "spotify_dm" || method === "instagram_dm") {
    return { ok:true, method_used:method, action_taken:"instructions_only", cooldown_until:null, message_to_user:"💬 *" + method.replace("_"," ") + "* — reach out manually for *" + playlistName + "*. Track: *" + trackName + "*" + (subUrl ? "\nLink: " + subUrl : "") };
  }
  if (NON_BULK_METHODS.has(method)) {
    return { ok:true, method_used:method, action_taken:"instructions_only", cooldown_until:null, message_to_user:"🤖 *" + method + "* — needs manual/distributor workflow for *" + playlistName + "* (*" + trackName + "*)." };
  }
  return { ok:true, method_used:method, action_taken:subUrl?"link_delivered":"instructions_only", cooldown_until:null, message_to_user:subUrl ? "🔗 *" + playlistName + "* — " + subUrl + "\nTrack: *" + trackName + "*" : "📋 *" + playlistName + "* — method *" + method + "*. Pitch *" + trackName + "* via the curator channel." };
}
