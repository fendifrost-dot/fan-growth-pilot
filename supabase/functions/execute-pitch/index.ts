import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  defaultPlaylistPitchSubject,
  htmlToPlainText,
  pitchFromHeader,
  pitchReplyTo,
} from "../_shared/resend-pitch.ts";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};
const NON_BULK_METHODS = new Set(["algorithmic", "distributor_pitch"]);
const MAX_DAILY_PITCHES = 30; // raised from 10 on 2026-06-10 to clear queued batch-3 sends

// Curator-friendly send window: Mon–Fri, 10:00–16:00 America/Chicago (CT). Uses the
// IANA zone so DST (CDT/CST) is handled automatically rather than a fixed offset.
const SEND_WINDOW_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const SEND_WINDOW_START_HOUR = 10; // inclusive
const SEND_WINDOW_END_HOUR = 16; // exclusive (4p)
function isWithinSendWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  let hour = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
  return (
    SEND_WINDOW_DAYS.has(weekday) &&
    hour >= SEND_WINDOW_START_HOUR &&
    hour < SEND_WINDOW_END_HOUR
  );
}
function getHubKey(req: Request): string {
  return (req.headers.get("x-api-key") || req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
}
type PitchResponse = {
  ok: boolean; method_used: string;
  action_taken: "email_sent"|"instructions_only"|"link_delivered"|"skipped"|"tier_gate"|"error";
  cooldown_until: string|null; message_to_user: string;
  pitch_log_id?: string | null;
};

async function resolveCuratorEmail(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  draft?: { email?: string },
): Promise<string | null> {
  let email = (draft?.email || (row.curator_email as string | null))?.trim() ?? "";
  if (!email) {
    const { data: target } = await sb.from("playlist_targets")
      .select("curator_email")
      .eq("playlist_id", String(row.playlist_id))
      .maybeSingle();
    email = (target?.curator_email as string | null)?.trim() ?? "";
  }
  return email || null;
}

function pitchLogRow(
  playlistId: string,
  trackName: string,
  curatorEmail: string,
  method: string,
  status: string,
  extra: {
    cooldown_until?: string | null;
    response_notes?: string;
    pitched_at?: string;
    resend_message_id?: string | null;
  } = {},
) {
  return {
    playlist_id: playlistId,
    track_name: trackName,
    curator_email: curatorEmail,
    method,
    status,
    pitched_at: extra.pitched_at ?? new Date().toISOString(),
    cooldown_until: extra.cooldown_until ?? null,
    response_notes: extra.response_notes ?? null,
    resend_message_id: extra.resend_message_id ?? null,
  };
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
    const provided = getHubKey(req).trim();
    // Auth is optional and only validated when both sides provide a value.
    // - No env configured -> allow (internal-only deployment).
    // - No header provided -> allow.
    // - Both present but mismatched -> reject as bad explicit key.
    if (expected && provided && provided !== expected) return json({ error: "Unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlist_id || "").trim();
    const trackName = String(body.track_name || "").trim();
    const methodOverride = typeof body.method_override === "string" ? body.method_override.trim() : "";
    const tierConfirmed = Boolean(body.tier_confirmed);
    const bulk = Boolean(body.bulk);
    const draftId = String(body.draft_id ?? "").trim();
    const testMode = Boolean(body.test_mode);
    const testEmail = String(body.test_email ?? "fendifrost@gmail.com").trim() || "fendifrost@gmail.com";
    const batchOverrideCap = Boolean(body.batch_override_cap);
    // Escape hatch for legitimate off-hours admin sends; defaults to enforcing the window.
    const ignoreSendWindow = Boolean(body.ignore_send_window);
    if (!playlistId || !trackName) return jsonPitch({ ok:false, method_used:"none", action_taken:"error", cooldown_until:null, message_to_user:"Missing playlist_id or track_name." });
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(url, key);
    let draftOverrides: { email?: string; subject?: string; bodyHtml?: string } | undefined;
    let draftChannel: string | null = null;
    if (draftId) {
      const { data: draft } = await sb.from("outreach_drafts").select("*").eq("id", draftId).maybeSingle();
      if (!draft || draft.status !== "approved") {
        return jsonPitch({ ok:false, method_used:"none", action_taken:"error", cooldown_until:null, message_to_user:"Draft not found or not approved: " + draftId });
      }
      draftChannel = String(draft.channel ?? "").toLowerCase();
      const plain = String(draft.body ?? "").replace(/\n/g, "<br>");
      draftOverrides = {
        email: (draft.recipient as string | null)?.trim() || undefined,
        subject: (draft.subject as string | null)?.trim() || undefined,
        bodyHtml: "<p>" + plain + "</p>",
      };
    }
    const { data: row, error: rowErr } = await sb.from("playlist_targets").select("*").eq("playlist_id", playlistId).maybeSingle();
    if (rowErr || !row) return jsonPitch({ ok:false, method_used:"none", action_taken:"error", cooldown_until:null, message_to_user:"Playlist not found: " + playlistId });
    const method = (draftChannel === "email" ? "email" : (methodOverride || row.submission_method || "other")).toLowerCase().trim();
    if (bulk && NON_BULK_METHODS.has(method)) return jsonPitch({ ok:true, method_used:method, action_taken:"skipped", cooldown_until:null, message_to_user:"⏭️ Skipped *" + (row.playlist_name ?? playlistId) + "* — method *" + method + "* needs a manual pass." });
    const tierRaw = row.tier;
    const tier = typeof tierRaw === "number" ? tierRaw : tierRaw != null && tierRaw !== "" ? Number(tierRaw) : null;
    if (tier === 3 && !tierConfirmed) return jsonPitch({ ok:false, method_used:method, action_taken:"tier_gate", cooldown_until:null, message_to_user:"⚠️ *Tier 3 playlist* — *" + (row.playlist_name ?? playlistId) + "*\n\nFlagged for verify-first pitching. Reply *confirm* to send." });
    if (method === "email") return await handleEmailPitch(sb, row, trackName, bulk, draftOverrides, testMode, testEmail, batchOverrideCap, ignoreSendWindow);
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
async function handleEmailPitch(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  trackName: string,
  _bulk: boolean,
  draft?: { email?: string; subject?: string; bodyHtml?: string },
  testMode = false,
  testEmail = "fendifrost@gmail.com",
  batchOverrideCap = false,
  ignoreSendWindow = false,
): Promise<Response> {
  const playlistId = String(row.playlist_id);
  const curatorEmail = await resolveCuratorEmail(sb, row, draft);
  const email = testMode ? testEmail : curatorEmail;
  const playlistName = (row.playlist_name as string|null) ?? playlistId;
  const method = "email";
  if (!email) {
    return jsonPitch({
      ok: false, method_used: method, action_taken: "error", cooldown_until: null,
      message_to_user: "No curator email on file for *" + playlistName + "*. Patch playlist_targets before sending.",
    });
  }
  // test_mode bypasses send-window + cooldown + daily cap checks (QA sends should be unblocked).
  if (!testMode) {
    // Real curator emails only go out Mon–Fri 10a–4p CT unless explicitly overridden.
    if (!ignoreSendWindow && !isWithinSendWindow(new Date())) {
      return jsonPitch({ ok:false, method_used:method, action_taken:"skipped", cooldown_until:null, message_to_user:"🕑 Outside send window for *" + playlistName + "*. Pitch emails go out *Mon–Fri 10a–4p CT*. Retry during the window (or pass ignore_send_window to force)." });
    }
    const { data: existing } = await sb.from("pitch_log").select("id, cooldown_until").eq("playlist_id", playlistId).eq("track_name", trackName).eq("status", "sent").gt("cooldown_until", new Date().toISOString()).maybeSingle();
    if (existing?.id) {
      const until = existing.cooldown_until ? new Date(existing.cooldown_until as string).toLocaleDateString() : "?";
      return jsonPitch({ ok:false, method_used:method, action_taken:"skipped", cooldown_until:existing.cooldown_until as string, message_to_user:"⏳ Already pitched *" + playlistName + "* for *" + trackName + "*. Cooldown until *" + until + "*." });
    }
    if (!batchOverrideCap) {
      const { count: capCount } = await sb.from("pitch_log").select("*", { count:"exact", head:true }).eq("method", "email").eq("status", "sent").gte("pitched_at", new Date(Date.now() - 86400000).toISOString());
      if ((capCount ?? 0) >= MAX_DAILY_PITCHES) return jsonPitch({ ok:false, method_used:method, action_taken:"skipped", cooldown_until:null, message_to_user:`📧 Daily email pitch cap reached (${MAX_DAILY_PITCHES} per 24h). Try again tomorrow.` });
    }
  }
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = pitchFromHeader();
  const { artistId, trackUrls } = await getArtistConfig(sb);
  const trackUrl = trackUrls[trackName] || trackUrls[trackName.toLowerCase()] || "https://open.spotify.com/artist/" + (artistId || "0000000000000000000000");
  const cooldownDays = await getCooldownDays(sb);
  const cooldownIso = new Date(Date.now() + cooldownDays * 86400000).toISOString();
  const bodyHtml = draft?.bodyHtml ?? ["<p>Hi,</p>","<p>I'm reaching out to submit <strong>" + escapeHtml(trackName) + "</strong> by <strong>Fendi Frost</strong> for playlist consideration.</p>","<p>Listen: <a href=\"" + escapeHtml(trackUrl) + "\">" + escapeHtml(trackUrl) + "</a></p>",artistId ? "<p>Artist on Spotify: <a href=\"https://open.spotify.com/artist/" + escapeHtml(artistId) + "\">profile</a></p>" : "","<p>Thank you for your time.</p>","<p>— Fendi Frost team</p>"].filter(Boolean).join("\n");
  const subject = draft?.subject ?? defaultPlaylistPitchSubject(trackName, playlistName);
  if (!resendKey) {
    if (!testMode) {
      await sb.from("pitch_log").insert(pitchLogRow(playlistId, trackName, email, method, "error", {
        response_notes: "RESEND_API_KEY not configured",
      }));
    }
    return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"❌ Email not sent (Hub missing RESEND_API_KEY)." });
  }
  const textBody = htmlToPlainText(bodyHtml);
  const resendBody: Record<string, unknown> = {
    from: fromEmail,
    to: [email],
    subject,
    text: textBody,
    html: bodyHtml,
  };
  const replyTo = pitchReplyTo();
  if (replyTo) resendBody.reply_to = replyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
    body: JSON.stringify(resendBody),
  });
  const raw = await res.text();
  let resendMessageId: string | null = null;
  if (res.ok) {
    try {
      const parsed = JSON.parse(raw) as { id?: string };
      resendMessageId = typeof parsed?.id === "string" ? parsed.id : null;
    } catch { /* non-JSON success body */ }
  }
  if (!res.ok) {
    if (!testMode) {
      await sb.from("pitch_log").insert(pitchLogRow(playlistId, trackName, email, method, "error", {
        response_notes: "Resend " + res.status + ": " + raw.slice(0, 500),
      }));
    }
    return jsonPitch({ ok:false, method_used:method, action_taken:"error", cooldown_until:null, message_to_user:"❌ Email failed (" + res.status + "). No cooldown applied — retry after fixing." });
  }
  if (testMode) {
    // Zero state footprint: no pitch_log row, no cooldown_until applied.
    return jsonPitch({
      ok: true, method_used: method, action_taken: "email_sent", cooldown_until: null,
      pitch_log_id: null,
      message_to_user: "🧪 [TEST MODE] Pitch email sent to *" + email + "* for *" + playlistName + "* (" + trackName + "). No pitch_log row, no cooldown applied.",
    });
  }
  const { data: logRow, error: insOk } = await sb.from("pitch_log")
    .insert(pitchLogRow(playlistId, trackName, email, method, "sent", {
      cooldown_until: cooldownIso,
      resend_message_id: resendMessageId,
    }))
    .select("id")
    .single();
  if (insOk) {
    console.error("pitch_log insert after send:", insOk.message, { playlistId, trackName, email });
    return jsonPitch({
      ok: false, method_used: method, action_taken: "error", cooldown_until: null,
      message_to_user: "❌ Email sent but logging failed: " + insOk.message,
    });
  }
  return jsonPitch({
    ok: true, method_used: method, action_taken: "email_sent", cooldown_until: cooldownIso,
    pitch_log_id: logRow?.id ?? null,
    message_to_user: "📧 Pitch email sent to *" + email + "* for *" + playlistName + "* (" + trackName + "). Cooldown until " + new Date(cooldownIso).toLocaleDateString() + ".",
  });
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
