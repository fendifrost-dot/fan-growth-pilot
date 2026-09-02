import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-pitch.ts";
import {
  checkControlCooldown,
  requireHubKey,
  requireSendIdentity,
} from "../_shared/send-identity-gate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const auth = requireHubKey(req);
    if (!auth.ok) {
      console.error("send-pitch-email auth failed:", auth.error);
      return json({ error: auth.error }, 401);
    }

    const payload = await req.json();
    const kind = String(payload.kind ?? "playlist").toLowerCase();

    if (kind === "radio") {
      return await handleRadioPitch(payload);
    }

    // Playlist branch: same campaign/track gate as execute-pitch. No title-only bypass.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const identity = await requireSendIdentity(supabase, payload as Record<string, unknown>);
    if (!identity.ok) {
      return json({ error: identity.error }, identity.status);
    }

    const { playlist_id, curator_email, curator_name, playlist_name, subject, body } = payload;
    const track_name = identity.identity.trackName;
    const track_id = identity.identity.trackId;
    const campaign_id = identity.identity.campaignId;

    if (!curator_email || !subject || !body || !playlist_id) {
      return json({
        error: "curator_email, subject, body, playlist_id, track_id, and campaign_id are required",
      }, 400);
    }

    if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "RESEND_API_KEY not configured" }, 500);

    const hold = await checkControlCooldown(supabase, {
      trackId: track_id,
      playlistId: String(playlist_id),
    });
    if (hold.blocked) {
      return json({
        error: hold.message,
        cooldown_until: hold.cooldown_until,
        skipped: true,
      }, 422);
    }

    let finalBody = body;

    // Auto-generate body if requested
    if (body === "auto") {
      const { data: targetData } = await supabase
        .from("playlist_targets")
        .select("research_context, overlap_score, matched_artists")
        .eq("playlist_id", playlist_id)
        .maybeSingle();

      if (targetData?.research_context) {
        const ctx = targetData.research_context as Record<string, unknown>;
        const artists = Object.values((ctx.neighborhood_artists as Record<string, unknown>) || {})
          .slice(0, 3)
          .join(", ");
        const features = (ctx.audio_features as Record<string, unknown>) || {};
        const tempo = features.tempo ? `${Math.round(Number(features.tempo))}bpm` : "";
        const energy = features.energy !== undefined
          ? `energy ${Math.round(Number(features.energy) * 100)}%`
          : "";

        finalBody = `Hi ${curator_name || "there"},

I came across your playlist "${playlist_name}" and think my track "${track_name}" would be a great fit.

My data shows my audience overlaps heavily with fans of ${artists || "similar artists"} — my track runs at ${tempo} with ${energy}, fitting naturally alongside what you're already curating.

Would love for you to give it a listen. Happy to share any additional info.

Best,
Fendi Frost`;
      }
    }

    const sent = await sendResendEmail({
      to: [curator_email],
      subject,
      text: finalBody,
    });
    if (!sent.ok) {
      return json({ error: `Email send failed: ${sent.status} - ${sent.error}` }, sent.status >= 500 ? 500 : 422);
    }

    // Log with exact track_id + campaign_id (no title-only rows).
    await supabase.from("pitch_log").insert({
      playlist_id,
      track_name,
      track_id,
      campaign_id,
      curator_email,
      subject,
      email_body: finalBody,
      status: "sent",
      sent_at: new Date().toISOString(),
      resend_message_id: sent.id,
    });

    await supabase
      .from("playlist_targets")
      .update({ pitch_status: "pitched", pitched_at: new Date().toISOString() })
      .eq("playlist_id", playlist_id);

    return json({
      success: true,
      message_id: sent.id,
      to: curator_email,
      track: track_name,
      track_id,
      campaign_id,
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

  return json({
    success: true,
    kind: "radio",
    message_id: sent.id,
    to: curatorEmail,
    track: trackName,
    station_id: stationId,
    pitch_log_id: pitchLogId || null,
  });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
