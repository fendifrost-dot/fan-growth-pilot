import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-pitch.ts";
import { evaluateOutreachDecision } from "../_shared/outreach-decision.ts";
import { verifyDraftPitchIntegrity } from "../_shared/pitch-copy-integrity.ts";

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

    // Playlist pitches must dispatch the exact Grok-approved draft artefact.
    const draftId = String(payload.draft_id ?? "").trim();
    if (!draftId) {
      return json({
        error:
          "draft_id required. send-pitch-email dispatches only the approved draft's recipient, subject, and body — caller-supplied message fields are not accepted.",
      }, 422);
    }

    if (!Deno.env.get("RESEND_API_KEY")) return json({ error: "RESEND_API_KEY not configured" }, 500);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: draft } = await supabase.from("outreach_drafts").select("*").eq("id", draftId).maybeSingle();
    if (!draft || String(draft.status) !== "approved") {
      return json({ error: "Draft not found or not approved", draft_id: draftId }, 422);
    }
    if (String(draft.channel ?? "").toLowerCase() !== "email") {
      return json({ error: "Draft channel is not email", draft_id: draftId, channel: draft.channel }, 422);
    }

    const playlistId = String(draft.playlist_id ?? "").trim();
    const curatorEmail = String(draft.recipient ?? "").trim();
    const subject = String(draft.subject ?? "").trim();
    const body = String(draft.body ?? "").trim();
    const trackId = String(draft.track_id ?? "").trim();
    const trackName = String(draft.track_name ?? "").trim();
    const campaignId = String(draft.campaign_id ?? "").trim();
    const songDnaVersionId = String(draft.song_dna_version_id ?? "").trim();

    if (!curatorEmail || !subject || !body || !playlistId) {
      return json({
        error: "Approved draft is missing recipient, subject, body, or playlist_id",
        draft_id: draftId,
      }, 400);
    }
    if (!trackId) {
      return json({ error: "Approved draft missing track_id", draft_id: draftId }, 422);
    }

    // Reject caller attempts to mix approved draft with different message fields.
    const callerEmail = payload.curator_email != null ? String(payload.curator_email).trim() : "";
    const callerSubject = payload.subject != null ? String(payload.subject).trim() : "";
    const callerBody = payload.body != null ? String(payload.body).trim() : "";
    if (callerEmail && callerEmail.toLowerCase() !== curatorEmail.toLowerCase()) {
      return json({
        error: "curator_email does not match the approved draft. Re-approve a changed submission with Grok.",
      }, 422);
    }
    if (callerSubject && callerSubject !== subject) {
      return json({
        error: "subject does not match the approved draft. Re-approve a changed submission with Grok.",
      }, 422);
    }
    if (callerBody && callerBody !== "auto" && callerBody !== body) {
      return json({
        error: "body does not match the approved draft. Re-approve a changed submission with Grok.",
      }, 422);
    }
    if (payload.body === "auto") {
      return json({
        error: "body=auto is disabled. Dispatch the exact approved draft body.",
      }, 422);
    }

    const integrity = await verifyDraftPitchIntegrity(supabase, draft);
    if (!integrity.ok) {
      return json({
        error: integrity.message,
        code: integrity.code,
        draft_id: draftId,
      }, 422);
    }

    const decision = await evaluateOutreachDecision(supabase, {
      route: "send-pitch-email",
      trackId,
      trackName: trackName || null,
      campaignId: campaignId || null,
      songDnaVersionId: songDnaVersionId || null,
      playlistId,
    });
    if (!decision.allow) {
      return json({
        error: decision.errors[0] ?? decision.code,
        decision_code: decision.code,
        errors: decision.errors,
      }, 422);
    }

    const resolvedTrackName = decision.trackName || trackName;

    const sent = await sendResendEmail({
      to: [curatorEmail],
      subject,
      text: body,
    });
    if (!sent.ok) {
      return json({ error: `Email send failed: ${sent.status} - ${sent.error}` }, sent.status >= 500 ? 500 : 422);
    }

    await supabase.from("pitch_log").insert({
      playlist_id: playlistId,
      track_name: resolvedTrackName,
      track_id: decision.trackId,
      song_dna_version_id: decision.songDnaVersionId,
      campaign_id: decision.campaignId,
      curator_email: curatorEmail,
      subject,
      email_body: body,
      sent_at: new Date().toISOString(),
      resend_message_id: sent.id,
      draft_id: draftId,
      pitch_copy_source: integrity.source,
      pitch_copy_hash: integrity.hash,
      dispatched_via: "send-pitch-email",
    });

    await supabase
      .from("playlist_targets")
      .update({ pitch_status: "pitched", pitched_at: new Date().toISOString() })
      .eq("playlist_id", playlistId);

    await supabase.from("outreach_drafts").update({
      status: "sent",
      sent_at: new Date().toISOString(),
    }).eq("id", draftId);

    return json({
      success: true,
      message_id: sent.id,
      to: curatorEmail,
      track: resolvedTrackName,
      track_id: decision.trackId,
      playlist: payload.playlist_name || playlistId,
      draft_id: draftId,
      pitch_copy_source: integrity.source,
      pitch_copy_hash: integrity.hash,
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
