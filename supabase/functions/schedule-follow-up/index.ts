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
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");

    if (body.run === "cron") {
      const now = new Date().toISOString();
      const { data: due, error } = await sb
        .from("pitch_log")
        .select("id, playlist_id, track_name, method")
        .eq("status", "sent")
        .lte("follow_up_at", now)
        .not("follow_up_at", "is", null);
      if (error) return json({ error: error.message }, 500);

      const created: string[] = [];
      const errors: string[] = [];

      for (const row of due ?? []) {
        const channel = row.method === "email" ? "email"
          : row.method === "instagram_dm" ? "instagram_dm"
          : "web_form";

        const { data: pl } = await sb.from("playlist_targets").select("why_it_fits, recommended_pitch_angle")
          .eq("playlist_id", row.playlist_id).maybeSingle();

        const draftRes = await fetch(`${base}/functions/v1/draft-pitch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": expected },
          body: JSON.stringify({
            playlist_id: row.playlist_id,
            track_name: row.track_name,
            channel,
            generated_by: "schedule-follow-up:cron",
          }),
        });
        const draftData = await draftRes.json().catch(() => ({}));
        if (!draftRes.ok) {
          errors.push(`${row.id}: ${(draftData as { error?: string }).error ?? draftRes.status}`);
          continue;
        }

        const draftId = (draftData as { draft_id?: string }).draft_id;
        if (draftId) {
          const prefix = "Quick follow-up — ";
          const baseBody = (draftData as { body?: string }).body ?? "";
          await sb.from("outreach_drafts").update({
            body: prefix + baseBody,
            metadata: { follow_up_for: row.id, why_it_fits: pl?.why_it_fits ?? null },
          }).eq("id", draftId);
          created.push(draftId);
        }

        await sb.from("pitch_log").update({ follow_up_at: null }).eq("id", row.id);
      }

      return json({
        ok: true,
        due_count: due?.length ?? 0,
        drafts_created: created.length,
        draft_ids: created,
        errors,
      });
    }

    const pitchLogId = String(body.pitch_log_id ?? "").trim();
    const days = Number(body.days);
    if (!pitchLogId || !Number.isFinite(days) || days < 1) {
      return json({ error: "pitch_log_id and days (>=1) required" }, 400);
    }

    const followUpAt = new Date(Date.now() + days * 86400000).toISOString();
    const { error: upErr } = await sb.from("pitch_log").update({ follow_up_at: followUpAt }).eq(
      "id",
      pitchLogId,
    );
    if (upErr) return json({ error: upErr.message }, 500);

    return json({ ok: true, pitch_log_id: pitchLogId, follow_up_at: followUpAt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
