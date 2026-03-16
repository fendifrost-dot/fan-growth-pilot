import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = req.headers.get("x-api-key");
    const expectedKey = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expectedKey || !apiKey || apiKey !== expectedKey) {
      return json({ error: "Unauthorized" }, 401);
    }

    const { playlist_id, curator_email, curator_name, playlist_name, track_name, subject, body } = await req.json();

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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
