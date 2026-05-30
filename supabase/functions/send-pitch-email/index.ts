import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { playlist_id, curator_email, curator_name, playlist_name, track_name, subject, body } = payload;

    if (!curator_email || !subject || !body || !track_name || !playlist_id) {
      return json({ error: "curator_email, subject, body, track_name, and playlist_id are required" }, 400);
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL") || "pitches@fendifrost.com";

    if (!resendKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let finalBody = body;

    // Auto-generate body if requested
    if (body === "auto") {
      const { data: targetData } = await supabase
        .from("playlist_targets")
        .select("research_context, overlap_score, matched_artists")
        .eq("playlist_id", playlist_id)
        .maybeSingle();

      if (targetData?.research_context) {
        const ctx = targetData.research_context as any;
        const artists = Object.values(ctx.neighborhood_artists || {}).slice(0, 3).join(", ");
        const features = ctx.audio_features || {};
        const tempo = features.tempo ? `${Math.round(features.tempo)}bpm` : "";
        const energy = features.energy !== undefined ? `energy ${Math.round(features.energy * 100)}%` : "";

        finalBody = `Hi ${curator_name || "there"},

I came across your playlist "${playlist_name}" and think my track "${track_name}" would be a great fit.

My data shows my audience overlaps heavily with fans of ${artists || "similar artists"} — my track runs at ${tempo} with ${energy}, fitting naturally alongside what you're already curating.

Would love for you to give it a listen. Happy to share any additional info.

Best,
Fendi Frost`;
      }
    }

    // Send email via Resend
    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Fendi Frost <${fromEmail}>`,
        to: [curator_email],
        subject,
        text: finalBody,
        html: finalBody.replace(/\n/g, "<br>"),
      }),
    });

    if (!resendResp.ok) {
      const errText = await resendResp.text();
      return json({ error: `Email send failed: ${resendResp.status} - ${errText}` }, 500);
    }

    const resendData = await resendResp.json();

    // Log the pitch
    await supabase.from("pitch_log").insert({
      playlist_id,
      track_name,
      curator_email,
      subject,
      email_body: finalBody,
      sent_at: new Date().toISOString(),
      resend_message_id: resendData.id,
    });

    // Update playlist target status
    await supabase
      .from("playlist_targets")
      .update({ pitch_status: "pitched", pitched_at: new Date().toISOString() })
      .eq("playlist_id", playlist_id);

    return json({
      success: true,
      message_id: resendData.id,
      to: curator_email,
      track: track_name,
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

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const fromEmail = Deno.env.get("FROM_EMAIL") || "pitches@fendifrost.com";
  if (!resendKey) return json({ error: "RESEND_API_KEY not configured" }, 500);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const sentAt = new Date().toISOString();

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Fendi Frost <${fromEmail}>`,
      to: [curatorEmail],
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    }),
  });

  if (!resendResp.ok) {
    const errText = await resendResp.text();
    if (pitchLogId) {
      await supabase.from("radio_pitch_log").update({
        status: "error",
        body: `${body}\n\n--- send error ---\n${errText.slice(0, 500)}`,
      }).eq("id", pitchLogId);
    }
    return json({ error: `Email send failed: ${resendResp.status} - ${errText}` }, 500);
  }

  const resendData = await resendResp.json() as { id?: string };

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
    resend_message_id: resendData.id ?? null,
  };

  if (pitchLogId) {
    const { error: upErr } = await supabase.from("radio_pitch_log").update(logPatch).eq("id", pitchLogId);
    if (upErr) {
      console.error("radio_pitch_log update failed after send:", upErr.message);
      return json({
        error: `Email sent but logging failed: ${upErr.message}`,
        message_id: resendData.id,
      }, 500);
    }
  } else {
    const { error: insErr } = await supabase.from("radio_pitch_log").insert(logPatch);
    if (insErr) {
      console.error("radio_pitch_log insert failed after send:", insErr.message);
      return json({
        error: `Email sent but logging failed: ${insErr.message}`,
        message_id: resendData.id,
      }, 500);
    }
  }

  return json({
    success: true,
    kind: "radio",
    message_id: resendData.id,
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
