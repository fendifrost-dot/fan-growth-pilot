/**
 * Hub-key admin read/write for playlist_targets + outreach_drafts (RLS blocks authenticated client).
 */
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
    const action = String(body.action ?? "").trim();
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "list_targets") {
      let q = sb.from("playlist_targets").select(
        "playlist_id, playlist_name, curator_name, curator_email, curator_instagram, lane, tier, authenticity_score, fraud_verdict, contact_confidence, pitch_status, follower_count, is_active, why_it_fits, recommended_pitch_angle, submission_url",
      ).eq("is_active", true).order("follower_count", { ascending: false, nullsFirst: false }).limit(200);

      if (body.lane) q = q.eq("lane", String(body.lane));
      if (body.tier != null && body.tier !== "") q = q.eq("tier", Number(body.tier));
      if (body.fraud_verdict) q = q.eq("fraud_verdict", String(body.fraud_verdict));
      if (body.has_email) q = q.not("curator_email", "is", null);
      if (body.has_social) {
        q = q.or("curator_instagram.not.is.null,curator_tiktok.not.is.null,curator_twitter.not.is.null");
      }

      const { data, error } = await q;
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "deactivate_target") {
      const playlistId = String(body.playlist_id ?? "").trim();
      if (!playlistId) return json({ error: "playlist_id required" }, 400);
      const { error } = await sb.from("playlist_targets").update({ is_active: false }).eq(
        "playlist_id",
        playlistId,
      );
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "list_drafts") {
      const statuses = body.statuses ?? ["pending", "approved"];
      const { data, error } = await sb
        .from("outreach_drafts")
        .select("*")
        .in("status", statuses)
        .order("generated_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rows: data ?? [] });
    }

    if (action === "update_draft") {
      const draftId = String(body.draft_id ?? "").trim();
      if (!draftId) return json({ error: "draft_id required" }, 400);
      const patch: Record<string, unknown> = {};
      if (body.subject !== undefined) patch.subject = body.subject;
      if (body.body !== undefined) patch.body = body.body;
      if (body.recipient !== undefined) patch.recipient = body.recipient;
      const { error } = await sb.from("outreach_drafts").update(patch).eq("id", draftId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
