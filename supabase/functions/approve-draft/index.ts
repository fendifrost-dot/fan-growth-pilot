import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

function getHubKey(req: Request): string {
  return (
    req.headers.get("x-api-key") ||
    req.headers.get("apikey") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim()
  );
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const draftId = String(body.draft_id ?? "").trim();
    const approvedBy = String(body.approved_by ?? "admin").trim();
    const sendImmediately = Boolean(body.send_immediately);
    const reject = Boolean(body.reject);

    if (!draftId) return json({ error: "draft_id required" }, 400);

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: draft, error: dErr } = await sb
      .from("outreach_drafts")
      .select("*, playlist_targets(playlist_name, curator_name, curator_email, curator_instagram)")
      .eq("id", draftId)
      .maybeSingle();
    if (dErr || !draft) return json({ error: "Draft not found" }, 404);
    if (draft.status !== "pending") {
      return json({ error: `Draft status is ${draft.status}, expected pending` }, 400);
    }

    if (reject) {
      await sb.from("outreach_drafts").update({
        status: "rejected",
        approved_at: new Date().toISOString(),
        approved_by: approvedBy,
      }).eq("id", draftId);
      return json({ ok: true, status: "rejected" });
    }

    await sb.from("outreach_drafts").update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
    }).eq("id", draftId);

    if (!sendImmediately) {
      return json({ ok: true, status: "approved", sent: false });
    }

    const pl = draft.playlist_targets as Record<string, unknown> | null;
    const playlistName = (pl?.playlist_name as string) ?? draft.playlist_id;
    const curatorName = (pl?.curator_name as string) ?? "";
    const channel = draft.channel as string;

    if (channel === "web_form") {
      return json({
        ok: true,
        status: "approved",
        sent: false,
        manual_submit: true,
        submission_url: draft.recipient,
        message: "Open the submission URL and paste the draft body manually.",
      });
    }

    if (channel === "instagram_dm") {
      return json({
        ok: true,
        status: "approved",
        sent: false,
        needs_manual_dm: true,
        recipient: draft.recipient,
        body: draft.body,
        message: "IG username → recipient_id resolution not automated. Copy body and DM manually.",
      }, 422);
    }

    if (channel !== "email") {
      return json({ error: `Send not implemented for channel: ${channel}` }, 400);
    }

    const hubKey = expected;
    const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
    const email = (draft.recipient as string)?.trim() ||
      (pl?.curator_email as string | undefined)?.trim();
    if (!email) return json({ error: "No recipient email on draft" }, 400);

    const sendRes = await fetch(`${base}/functions/v1/send-pitch-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": hubKey,
      },
      body: JSON.stringify({
        playlist_id: draft.playlist_id,
        curator_email: email,
        curator_name: curatorName,
        playlist_name: playlistName,
        track_name: draft.track_name,
        subject: draft.subject ?? `Submission: ${draft.track_name} — Fendi Frost`,
        body: draft.body,
      }),
    });
    const sendData = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      return json({ error: (sendData as { error?: string }).error ?? `Send failed ${sendRes.status}` }, 500);
    }

    const { data: logRow } = await sb
      .from("pitch_log")
      .select("id")
      .eq("playlist_id", draft.playlist_id)
      .eq("track_name", draft.track_name)
      .order("pitched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    await sb.from("outreach_drafts").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      pitch_log_id: logRow?.id ?? null,
    }).eq("id", draftId);

    return json({
      ok: true,
      status: "sent",
      sent: true,
      channel: "email",
      send_result: sendData,
      pitch_log_id: logRow?.id ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
