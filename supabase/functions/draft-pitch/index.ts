import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { loadLanesConfig } from "../_shared/playlist-lanes.ts";

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

function pickChannel(
  row: Record<string, unknown>,
  channelOverride?: string,
): string | null {
  const ch = (channelOverride ?? "").trim().toLowerCase();
  if (ch) return ch;
  if ((row.curator_email as string | null)?.trim()) return "email";
  if ((row.curator_instagram as string | null)?.trim()) return "instagram_dm";
  if ((row.submission_url as string | null)?.trim()) return "web_form";
  return null;
}

function buildPitchBody(
  row: Record<string, unknown>,
  trackName: string,
  pitchAngle: string,
): string {
  const curator = (row.curator_name as string | null)?.trim() || "there";
  const playlist = (row.playlist_name as string | null)?.trim() || "your playlist";
  const why = (row.why_it_fits as string | null)?.trim();
  const angle = pitchAngle || (row.recommended_pitch_angle as string | null)?.trim() ||
    "Melodic rap with a deep-house groove — late-night luxury energy.";
  return [
    `Hi ${curator},`,
    "",
    `I'd love to submit **${trackName}** by **Fendi Frost** for *${playlist}*.`,
    "",
    angle,
    why ? `\n${why}` : "",
    "",
    "Happy to share the Spotify link or any extra context. Thank you for your time.",
    "",
    "— Fendi Frost",
  ].filter(Boolean).join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const expected = Deno.env.get("FANFUEL_HUB_KEY");
    if (!expected || getHubKey(req).trim() !== expected.trim()) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const playlistId = String(body.playlist_id ?? "").trim();
    const trackName = String(body.track_name ?? "").trim();
    const channelOverride = typeof body.channel === "string" ? body.channel : "";
    const generatedBy = String(body.generated_by ?? body.approved_by ?? "auto").trim() || "auto";

    if (!playlistId || !trackName) {
      return json({ error: "playlist_id and track_name required" }, 400);
    }

    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row, error: rowErr } = await sb
      .from("playlist_targets")
      .select("*")
      .eq("playlist_id", playlistId)
      .maybeSingle();
    if (rowErr || !row) return json({ error: "Playlist not found" }, 404);

    const channel = pickChannel(row, channelOverride);
    if (!channel) {
      return json({ error: "No outreach channel available (email, IG, or submission URL)" }, 400);
    }

    const lanes = await loadLanesConfig(sb);
    const lane = String(row.lane ?? "").trim();
    const pitchAngle = lane ? (lanes[lane]?.pitch_angle ?? "") : "";

    let recipient: string | null = null;
    if (channel === "email") recipient = (row.curator_email as string)?.trim() ?? null;
    else if (channel === "instagram_dm") recipient = (row.curator_instagram as string)?.trim() ?? null;
    else if (channel === "web_form") recipient = (row.submission_url as string)?.trim() ?? null;

    const subject = typeof body.override_subject === "string" && body.override_subject.trim()
      ? body.override_subject.trim()
      : `Submission for ${row.playlist_name}: Fendi Frost — ${trackName}`;

    const pitchBody = typeof body.override_body === "string" && body.override_body.trim()
      ? body.override_body.trim()
      : buildPitchBody(row, trackName, pitchAngle);

    const { data: draft, error: insErr } = await sb
      .from("outreach_drafts")
      .insert({
        playlist_id: playlistId,
        track_name: trackName,
        channel,
        recipient,
        subject: channel === "email" ? subject : null,
        body: pitchBody,
        generated_by: generatedBy,
        status: "pending",
        metadata: { lane: lane || null },
      })
      .select("id, channel, subject, body, recipient")
      .single();

    if (insErr) return json({ error: insErr.message }, 500);

    return json({
      ok: true,
      draft_id: draft.id,
      channel: draft.channel,
      subject: draft.subject,
      body: draft.body,
      recipient: draft.recipient,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 500);
  }
});
