/**
 * Shared identity + campaign gate for EVERY playlist email send path.
 * execute-pitch and send-pitch-email must both call this — no title-only bypass.
 *
 * Atomic cutover: set Lovable secret PITCH_IDENTITY_GATE=required only after
 * Song DNA schema + Fendi approvals + at least one live active campaign exist,
 * then redeploy execute-pitch AND send-pitch-email together. Until armed, both
 * playlist senders return 503 (fail closed — no half-open title-only path).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { assertSendCampaignIdentity } from "./pitch-campaigns.ts";
import {
  CONTROL_TRACK_ID,
  evaluateControlSameTargetCooldown,
  isControlTrackId,
} from "./control-cooldown.ts";

export type SendIdentity = {
  trackId: string;
  campaignId: string;
  trackName: string;
};

export type GateFail = { ok: false; status: number; error: string };
export type GateOk = { ok: true; identity: SendIdentity };

/** True only when Lovable secret PITCH_IDENTITY_GATE=required. */
export function isPitchIdentityGateArmed(): boolean {
  return (Deno.env.get("PITCH_IDENTITY_GATE") || "").trim().toLowerCase() === "required";
}

/**
 * Fail closed until cutover is armed. Prevents redeploying gated code while
 * the alternate sender (or legacy path) would still be half-open.
 */
export function requirePitchIdentityGateArmed(): GateFail | { ok: true } {
  if (isPitchIdentityGateArmed()) return { ok: true };
  return {
    ok: false,
    status: 503,
    error:
      "Pitch identity gate is not armed (PITCH_IDENTITY_GATE≠required). " +
      "Do not send until Song DNA + Fendi approvals + active campaigns exist, " +
      "then set the secret and redeploy execute-pitch + send-pitch-email together.",
  };
}

/**
 * Require exact track_id + campaign_id, resolve track name from UUID,
 * and verify the campaign is active/live for that track.
 */
export async function requireSendIdentity(
  sb: SupabaseClient,
  body: Record<string, unknown>,
): Promise<GateOk | GateFail> {
  const armed = requirePitchIdentityGateArmed();
  if (!armed.ok) return armed;

  const trackId = String(body.track_id ?? "").trim();
  const campaignId = String(body.campaign_id ?? "").trim();
  const trackNameBody = String(body.track_name ?? "").trim();

  if (!trackId || !campaignId) {
    return {
      ok: false,
      status: 400,
      error: "Missing exact track_id and campaign_id. Title-only sends are not allowed.",
    };
  }

  const { data: trackRow, error: trackErr } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", trackId)
    .maybeSingle();
  if (trackErr || !trackRow) {
    return { ok: false, status: 404, error: "track_id not found." };
  }
  const trackName = String(trackRow.name);
  if (trackNameBody && trackNameBody.toLowerCase() !== trackName.toLowerCase()) {
    return { ok: false, status: 400, error: "track_name does not match track_id." };
  }

  try {
    await assertSendCampaignIdentity(sb, { trackId, campaignId });
  } catch (e) {
    return {
      ok: false,
      status: 422,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, identity: { trackId, campaignId, trackName } };
}

/** Control same-target hold — UUID evidence only. */
export async function checkControlCooldown(
  sb: SupabaseClient,
  opts: { trackId: string; playlistId: string },
): Promise<{ blocked: false } | { blocked: true; message: string; cooldown_until: string }> {
  if (!isControlTrackId(opts.trackId)) return { blocked: false };
  const { data: priorControl } = await sb
    .from("pitch_log")
    .select("id")
    .eq("playlist_id", opts.playlistId)
    .eq("status", "sent")
    .eq("track_id", CONTROL_TRACK_ID)
    .limit(1)
    .maybeSingle();
  const hold = evaluateControlSameTargetCooldown({
    trackId: opts.trackId,
    playlistId: opts.playlistId,
    priorPitchExists: Boolean(priorControl?.id),
  });
  if (!hold.blocked) return { blocked: false };
  return {
    blocked: true,
    message: hold.message,
    cooldown_until: hold.cooldown_until,
  };
}

/**
 * Hub-key auth for send edge functions.
 * Rejects missing configured secret AND missing/incorrect credentials.
 * (Previously execute-pitch allowed missing credentials when no header was sent.)
 */
export function requireHubKey(req: Request): { ok: true } | { ok: false; error: string } {
  const expected = (Deno.env.get("FANFUEL_HUB_KEY") || "").trim();
  const xApiKey = (req.headers.get("x-api-key") || "").trim();
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const provided = (xApiKey || bearer).trim();

  if (!expected) {
    return {
      ok: false,
      error: "FANFUEL_HUB_KEY is not configured — refusing send (fail-closed).",
    };
  }
  if (!provided) {
    return {
      ok: false,
      error: "Missing credentials (x-api-key or Authorization Bearer). Sends require authentication.",
    };
  }
  if (provided !== expected) {
    return { ok: false, error: "Unauthorized" };
  }
  return { ok: true };
}
