/**
 * log_pitch_sent records a pitch that was already sent outside this backend.
 * It must carry track_id, Song DNA, and the cooldown columns from the draft
 * or handoff onto pitch_log. It does not send anything.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type LogPitchResult = { status: number; data: Record<string, unknown> };

function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function pick(...vals: unknown[]): string | null {
  for (const v of vals) {
    const t = s(v);
    if (t) return t;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function cooldownUntilIso(pitchedAt: string, days: number): string {
  const t = Date.parse(pitchedAt);
  const base = Number.isFinite(t) ? t : Date.now();
  const span = Number.isFinite(days) && days > 0 ? days : 90;
  return new Date(base + span * 86400000).toISOString();
}

/** Columns a logged send must persist. Empty identity values are omitted; cooldown_until is always set. */
export function loggedPitchIdentity(opts: {
  body: Record<string, unknown>;
  draft: Record<string, unknown> | null;
  handoff: Record<string, unknown> | null;
  pitchedAt: string;
  cooldownDays: number;
}): Record<string, unknown> {
  const { body, draft, handoff, pitchedAt, cooldownDays } = opts;
  const meta = asRecord(draft?.metadata);
  const packet = asRecord(handoff?.packet);
  const cooldown = pick(body.cooldown_until, meta.cooldown_until, packet.cooldown_until)
    ?? cooldownUntilIso(pitchedAt, cooldownDays);
  const fields: Record<string, unknown> = {
    track_id: pick(body.track_id, draft?.track_id, handoff?.track_id),
    song_dna_version_id: pick(
      body.song_dna_version_id,
      draft?.song_dna_version_id,
      handoff?.song_dna_version_id,
      meta.song_dna_version_id,
      packet.song_dna_version_id,
    ),
    draft_id: pick(body.draft_id, draft?.id),
    campaign_id: pick(body.campaign_id, draft?.campaign_id),
    approved_by: pick(draft?.approved_by, handoff?.approved_by),
    approved_at: pick(draft?.approved_at),
    follow_up_at: pick(body.follow_up_at, meta.follow_up_at, packet.follow_up_at),
    cooldown_until: cooldown,
  };
  const out: Record<string, unknown> = { cooldown_until: cooldown };
  for (const [k, v] of Object.entries(fields)) {
    if (k === "cooldown_until") continue;
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}

async function cooldownDays(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "cooldown_days").maybeSingle();
  const raw = (data as { value?: unknown } | null)?.value;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

export async function runLogPitchSent(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<LogPitchResult> {
  const playlistId = s(body.playlist_id ?? body.target_id);
  if (!playlistId) return { status: 400, data: { error: "playlist_id (or target_id) required" } };
  const channel = s(body.channel ?? "email").toLowerCase() || "email";
  const { data: target, error: targetErr } = await sb.from("playlist_targets")
    .select("playlist_id, track_name, curator_email")
    .eq("playlist_id", playlistId)
    .maybeSingle();
  if (targetErr) return { status: 500, data: { error: targetErr.message } };
  if (!target) return { status: 404, data: { error: "playlist_not_found", playlist_id: playlistId } };

  const draftId = s(body.draft_id);
  const handoffId = s(body.handoff_record_id);
  let draft: Record<string, unknown> | null = null;
  if (draftId) {
    const { data, error } = await sb.from("outreach_drafts")
      .select("id, playlist_id, track_id, track_name, song_dna_version_id, campaign_id, approved_by, approved_at, metadata")
      .eq("id", draftId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    draft = (data as Record<string, unknown> | null) ?? null;
  }

  const hintedTrack = s(body.track_id);
  const hintedName = s(body.track_name);
  if (!draft && (hintedTrack || hintedName)) {
    let q = sb.from("outreach_drafts")
      .select("id, playlist_id, track_id, track_name, song_dna_version_id, campaign_id, approved_by, approved_at, metadata")
      .eq("playlist_id", playlistId)
      .order("updated_at", { ascending: false })
      .limit(1);
    q = hintedTrack ? q.eq("track_id", hintedTrack) : q.eq("track_name", hintedName);
    const { data, error } = await q.maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    draft = (data as Record<string, unknown> | null) ?? null;
  }

  const trackName = hintedName || s(draft?.track_name) || s((target as { track_name?: string }).track_name);
  if (!trackName) {
    return { status: 400, data: { error: "track_name required (pass in body or set on playlist_targets)" } };
  }

  let handoff: Record<string, unknown> | null = null;
  if (handoffId) {
    const { data, error } = await sb.from("agh_handoff_records")
      .select("id, track_id, song_dna_version_id, approved_by, playlist_target_id, outreach_draft_id, packet")
      .eq("id", handoffId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    handoff = (data as Record<string, unknown> | null) ?? null;
  } else if (draft?.id || hintedTrack) {
    let q = sb.from("agh_handoff_records")
      .select("id, track_id, song_dna_version_id, approved_by, playlist_target_id, outreach_draft_id, packet")
      .eq("playlist_target_id", playlistId)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (draft?.id) q = q.eq("outreach_draft_id", draft.id);
    else q = q.eq("track_id", hintedTrack);
    const { data, error } = await q.maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    handoff = (data as Record<string, unknown> | null) ?? null;
  }

  const now = new Date().toISOString();
  const pitchedAt = s(body.sent_at) || now;
  const days = await cooldownDays(sb);
  const identity = loggedPitchIdentity({
    body,
    draft,
    handoff,
    pitchedAt,
    cooldownDays: days,
  });
  const curatorEmail = s((target as { curator_email?: string }).curator_email) || `${channel}:${playlistId}@manual`;

  const { data: existing, error: findErr } = await sb.from("pitch_log")
    .select("id")
    .eq("playlist_id", playlistId)
    .eq("track_name", trackName)
    .order("pitched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findErr) return { status: 500, data: { error: findErr.message } };

  let pitchLogId: string | null = (existing as { id?: string } | null)?.id ?? null;
  let created = false;
  const row = {
    method: channel,
    status: "sent",
    pitched_at: pitchedAt,
    sent_at: pitchedAt,
    dispatched_via: "log_pitch_sent",
    ...identity,
  };
  if (pitchLogId) {
    const { error: updErr } = await sb.from("pitch_log").update(row).eq("id", pitchLogId);
    if (updErr) return { status: 500, data: { error: updErr.message } };
  } else {
    const { data: logRow, error: logErr } = await sb.from("pitch_log").insert({
      playlist_id: playlistId,
      track_name: trackName,
      curator_email: curatorEmail,
      ...row,
    }).select("id").single();
    if (logErr) return { status: 500, data: { error: logErr.message } };
    pitchLogId = (logRow as { id?: string } | null)?.id ?? null;
    created = true;
  }
  const { error: upErr } = await sb.from("playlist_targets").update({
    pitch_status: "pitched",
    last_pitched_at: now,
  }).eq("playlist_id", playlistId);
  if (upErr) return { status: 500, data: { error: upErr.message } };
  return {
    status: 200,
    data: {
      ok: true,
      playlist_id: playlistId,
      track_name: trackName,
      channel,
      pitch_log_id: pitchLogId,
      created,
      track_id: identity.track_id ?? null,
      song_dna_version_id: identity.song_dna_version_id ?? null,
      cooldown_until: identity.cooldown_until ?? null,
    },
  };
}
