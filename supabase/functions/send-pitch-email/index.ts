import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-pitch.ts";
import { evaluateOutreachDecision } from "../_shared/outreach-decision.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const xApiKey = req.headers.get("x-api-key");
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const anonApiKey = req.headers.get("apikey");
    const providedKey = (xApiKey || bearerToken || anonApiKey || "").trim();
    const expectedKey = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
    if (!expectedKey || !providedKey || providedKey !== expectedKey) {
      console.error("Auth failed", {
        hasExpectedKey: !!expectedKey,
        expectedKeyLen: expectedKey.length,
        providedKeyLen: providedKey.length,
        headerUsed: xApiKey ? "x-api-key" : bearerToken ? "bearer" : anonApiKey ? "apikey" : "none",
      });
      return json({ error: "Unauthorized" }, 401);
    }

    const payload = await req.json();
    const kind = String(payload.kind ?? "playlist").toLowerCase();

    if (kind === "radio") {
      return await handleRadioPitch(payload);
    }

    const {
      playlist_id,
      curator_email,
      curator_name,
      playlist_name,
      track_name,
      track_id,
      campaign_id,
      song_dna_version_id,
      subject,
      body,
    } = payload;

    if (!curator_email || !subject || !body || !playlist_id) {
      return json({ error: "curator_email, subject, body, and playlist_id are required" }, 400);
    }
    if (!track_id && !track_name) {
      return json({ error: "track_id required (title-only send rejected)" }, 422);
    }

    if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "RESEND_API_KEY not configured" }, 500);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // body === "auto" inventing is removed — require real drafted body with track pitch.
    if (body === "auto") {
      return json({
        error:
          "body=auto is disabled. Provide a drafted body whose {{pitch}} came from approved track Song DNA / short_pitch.",
      }, 422);
    }

    const decision = await evaluateOutreachDecision(supabase, {
      route: "send-pitch-email",
      trackId: track_id ? String(track_id) : null,
      trackName: track_name ? String(track_name) : null,
      campaignId: campaign_id ? String(campaign_id) : null,
      songDnaVersionId: song_dna_version_id ? String(song_dna_version_id) : null,
      playlistId: String(playlist_id),
    });
    if (!decision.allow) {
      return json({
        error: decision.errors[0] ?? decision.code,
        decision_code: decision.code,
        errors: decision.errors,
      }, 422);
    }

    const finalBody = body;
    const resolvedTrackName = decision.trackName || String(track_name || "");

    const sent = await sendResendEmail({
      to: [curator_email],
      subject,
      text: finalBody,
    });
    if (!sent.ok) {
      return json({ error: `Email send failed: ${sent.status} - ${sent.error}` }, sent.status >= 500 ? 500 : 422);
    }

    // Log the pitch with exact identity when available
    await supabase.from("pitch_log").insert({
      playlist_id,
      track_name: resolvedTrackName,
      track_id: decision.trackId,
      song_dna_version_id: decision.songDnaVersionId,
      campaign_id: decision.campaignId,
      curator_email,
      subject,
      email_body: finalBody,
      sent_at: new Date().toISOString(),
      resend_message_id: sent.id,
    });

    // Update playlist target status
    await supabase
      .from("playlist_targets")
      .update({ pitch_status: "pitched", pitched_at: new Date().toISOString() })
      .eq("playlist_id", playlist_id);

    return json({
      success: true,
      message_id: sent.id,
      to: curator_email,
      track: resolvedTrackName,
      track_id: decision.trackId,
      playlist: playlist_name || playlist_id,
    });
  } catch (err) {
    console.error("send-pitch-email error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handleRadioPitch(payload: Record<string, unknown>) {
  const stationId = String(payload.station_id ?? "").trim();
  const curatorEmail = String(payload.curator_email ?? "").trim();
  const trackName = String(payload.track_name ?? "").trim();
  const subject = String(payload.subject ?? "").trim();
  const body = String(payload.body ?? "").trim();
  const pitchLogId = String(payload.pitch_log_id ?? "").trim();

  if (!stationId || !curatorEmail || !subject || !body || !trackName) {
    return json({ error: "radio: station_id, curator_email, subject, body, track_name required" }, 400);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const sentAt = new Date().toISOString();

  const sent = await sendResendEmail({ to: [curatorEmail], subject, text: body });
  if (!sent.ok) {
    if (pitchLogId) {
      await supabase.from("radio_pitch_log").update({
        status: "error",
        body: `${body}\n\n--- send error ---\n${sent.error.slice(0, 500)}`,
      }).eq("id", pitchLogId);
    }
    return json({ error: `Email send failed: ${sent.status} - ${sent.error}` }, 500);
  }

  const logPatch = {
    station_id: stationId,
    station_call_sign: payload.station_call_sign ?? null,
    song_id: payload.song_id ?? null,
    song_name: trackName,
    channel: "email",
    recipient: curatorEmail,
    subject,
    body,
    status: "sent",
    sent_at: sentAt,
    resend_message_id: sent.id ?? null,
  };

  if (pitchLogId) {
    const { error: upErr } = await supabase.from("radio_pitch_log").update(logPatch).eq("id", pitchLogId);
    if (upErr) {
      console.error("radio_pitch_log update failed after send:", upErr.message);
      return json({
        error: `Email sent but logging failed: ${upErr.message}`,
        message_id: sent.id,
      }, 500);
    }
  } else {
    const { error: insErr } = await supabase.from("radio_pitch_log").insert(logPatch);
    if (insErr) {
      console.error("radio_pitch_log insert failed after send:", insErr.message);
      return json({
        error: `Email sent but logging failed: ${insErr.message}`,
        message_id: sent.id,
      }, 500);
    }
  }

  await supabase.from("radio_targets").update({
    pitch_status: "pitched",
    last_pitched_at: sentAt,
  }).eq("station_id", stationId);

  return json({ success: true, message_id: sent.id, kind: "radio", station_id: stationId });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
