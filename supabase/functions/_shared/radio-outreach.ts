import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { enrichRadioContacts } from "./radio-enrich.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

const RADIO_ACTIONS = new Set([
  "draft_radio_pitch",
  "send_radio_pitch",
  "patch_radio_target",
  "get_radio_pitch_log",
  "backfill_apple_station_baseline",
  "enrich_radio_contacts",
]);

export function isRadioAction(action: string): boolean {
  return RADIO_ACTIONS.has(action);
}

function mondayOf(d: Date): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return dt.toISOString().slice(0, 10);
}

const DEFAULT_STREAM_LINKS: Record<string, string> = {
  "Designed For Me (Control)": "https://rnd.fm/track/designed-for-me-control",
};

type PlayedSong = { song_id?: string; song_name?: string | null; spins?: number };

async function syntheticSongIdFromName(songName: string): Promise<string> {
  const key = songName.toLowerCase().trim();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
  return `backfill-name:${hex}`;
}

async function resolvePlaySongId(s: PlayedSong): Promise<string | null> {
  const id = String(s.song_id ?? "").trim();
  if (id) return id;
  const name = (s.song_name as string | null)?.trim();
  if (!name) return null;
  return syntheticSongIdFromName(name);
}

function parseSongsPlayed(raw: unknown): PlayedSong[] {
  if (Array.isArray(raw)) return raw as PlayedSong[];
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function topPlayedSong(raw: unknown): PlayedSong | null {
  const songs = parseSongsPlayed(raw).filter((s) => (Number(s.spins) || 0) > 0);
  if (!songs.length) return null;
  return songs.sort((a, b) => (Number(b.spins) || 0) - (Number(a.spins) || 0))[0];
}

async function resolveStreamLink(sb: SupabaseClient, trackName: string): Promise<string> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "spotify_track_urls").maybeSingle();
  const urls = data?.value && typeof data.value === "object" && !Array.isArray(data.value)
    ? data.value as Record<string, string>
    : {};
  return urls[trackName]?.trim() || DEFAULT_STREAM_LINKS[trackName] || "";
}

async function resolveAmfaArtistId(sb: SupabaseClient, override?: string): Promise<string> {
  const fromBody = String(override ?? "").trim();
  if (fromBody) return fromBody;
  const envId = (Deno.env.get("AMFA_ARTIST_ID") || "").trim();
  if (envId) return envId;
  for (const key of ["amfa_artist_id", "apple_artist_id"]) {
    const { data } = await sb.from("artist_config").select("value").eq("key", key).maybeSingle();
    const v = typeof data?.value === "string" ? data.value.trim() : "";
    if (v) return v;
  }
  const { data: row } = await sb.from("radio_targets").select("metadata").limit(1).maybeSingle();
  const meta = row?.metadata as Record<string, unknown> | null;
  const fromMeta = String(meta?.artist_id ?? "").trim();
  if (fromMeta) return fromMeta;
  return "";
}

export function buildRadioPitchBody(
  target: Record<string, unknown>,
  newTrackName: string,
  streamLink: string,
): { subject: string; body: string; spunSong: PlayedSong | null } {
  const station = (target.station_call_sign as string | null)?.trim() || "your station";
  const contact = (target.contact_name as string | null)?.trim() || "there";
  const spun = topPlayedSong(target.songs_played);
  const spunName = (spun?.song_name as string | null)?.trim() || "my music";
  const subject = `Thanks for the spin — new track: ${newTrackName}`;
  const lines = [
    `Hi ${contact},`,
    "",
    `Thank you for spinning "${spunName}" on ${station} — really appreciated.`,
    "",
    `I wanted to share a new track, "${newTrackName}", in the same lane. Would love for you to give it a spin when you have a moment.`,
  ];
  if (streamLink) lines.push("", `Stream: ${streamLink}`);
  lines.push("", "Thank you,", "— Fendi Frost");
  return { subject, body: lines.join("\n"), spunSong: spun };
}

async function getCooldownDays(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("artist_config").select("value").eq("key", "cooldown_days").maybeSingle();
  if (!data?.value) return 90;
  const n = typeof data.value === "number" ? data.value : Number(data.value);
  return Number.isFinite(n) && n > 0 ? n : 90;
}

export async function runDraftRadioPitch(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const stationId = String(body.station_id ?? "").trim();
  const trackName = String(body.track_name ?? "").trim();
  if (!stationId || !trackName) {
    return { status: 400, data: { error: "station_id and track_name required" } };
  }

  const { data: target, error: tErr } = await sb.from("radio_targets").select("*").eq("station_id", stationId).maybeSingle();
  if (tErr || !target) return { status: 404, data: { error: "Station not found" } };

  const email = (target.contact_email as string | null)?.trim();
  if (!email) {
    return { status: 400, data: { error: "No contact_email on station — patch_target first" } };
  }

  const streamLink = await resolveStreamLink(sb, trackName);
  const built = buildRadioPitchBody(target, trackName, streamLink);
  const subject = typeof body.override_subject === "string" && body.override_subject.trim()
    ? body.override_subject.trim()
    : built.subject;
  const pitchBody = typeof body.override_body === "string" && body.override_body.trim()
    ? body.override_body.trim()
    : built.body;
  const spun = built.spunSong;

  const { data: draft, error: insErr } = await sb.from("radio_pitch_log").insert({
    station_id: stationId,
    station_call_sign: target.station_call_sign,
    song_id: spun?.song_id ?? null,
    song_name: trackName,
    channel: "email",
    recipient: email,
    subject,
    body: pitchBody,
    status: "draft",
  }).select("id, subject, body, recipient, status").single();

  if (insErr) return { status: 500, data: { error: insErr.message } };
  return {
    status: 200,
    data: {
      ok: true,
      pitch_id: draft.id,
      station_call_sign: target.station_call_sign,
      subject: draft.subject,
      body: draft.body,
      recipient: draft.recipient,
      spun_song: spun?.song_name ?? null,
    },
  };
}

export async function runSendRadioPitch(
  body: Record<string, unknown>,
  sb: SupabaseClient,
  hubKey: string,
): Promise<RunResult> {
  const stationId = String(body.station_id ?? "").trim();
  const trackName = String(body.track_name ?? "").trim();
  const pitchId = String(body.pitch_id ?? "").trim();
  if (!stationId || !trackName) {
    return { status: 400, data: { error: "station_id and track_name required" } };
  }

  const { data: target, error: tErr } = await sb.from("radio_targets").select("*").eq("station_id", stationId).maybeSingle();
  if (tErr || !target) return { status: 404, data: { error: "Station not found" } };

  let email = (target.contact_email as string | null)?.trim() ?? "";
  if (!email) return { status: 400, data: { error: "No contact_email — patch before sending" } };

  const cooldownDays = await getCooldownDays(sb);
  const cooldownAfter = new Date(Date.now() + cooldownDays * 86400000).toISOString();
  const { data: existing } = await sb.from("radio_pitch_log").select("id, sent_at")
    .eq("station_id", stationId).eq("song_name", trackName).eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - cooldownDays * 86400000).toISOString())
    .maybeSingle();
  if (existing?.id) {
    return {
      status: 422,
      data: {
        ok: false,
        error: `Cooldown active for ${target.station_call_sign} / ${trackName} until ${cooldownAfter.slice(0, 10)}`,
        pitch_id: existing.id,
      },
    };
  }

  const { count: capCount } = await sb.from("radio_pitch_log").select("*", { count: "exact", head: true })
    .eq("channel", "email").eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - 86400000).toISOString());
  if ((capCount ?? 0) >= 10) {
    return { status: 429, data: { error: "Daily radio email cap reached (10 per 24h)" } };
  }

  let draftRow: Record<string, unknown> | null = null;
  if (pitchId) {
    const { data } = await sb.from("radio_pitch_log").select("*").eq("id", pitchId).eq("status", "draft").maybeSingle();
    draftRow = data;
  }
  if (!draftRow) {
    const draftResult = await runDraftRadioPitch({ station_id: stationId, track_name: trackName, ...body }, sb);
    if (draftResult.status !== 200) return draftResult;
    const newId = String(draftResult.data.pitch_id ?? "");
    const { data } = await sb.from("radio_pitch_log").select("*").eq("id", newId).maybeSingle();
    draftRow = data;
  }

  const subject = String(draftRow?.subject ?? "").trim();
  const pitchBody = String(draftRow?.body ?? "").trim();
  const pitchLogId = String(draftRow?.id ?? "");
  if (!subject || !pitchBody || !pitchLogId) {
    return { status: 500, data: { error: "Draft row missing subject/body" } };
  }

  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  const sendRes = await fetch(`${base}/functions/v1/send-pitch-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": hubKey },
    body: JSON.stringify({
      kind: "radio",
      station_id: stationId,
      station_call_sign: target.station_call_sign,
      curator_email: email,
      curator_name: target.contact_name,
      track_name: trackName,
      song_id: draftRow.song_id,
      subject,
      body: pitchBody,
      pitch_log_id: pitchLogId,
    }),
  });
  const sendData = await sendRes.json().catch(() => ({})) as Record<string, unknown>;
  if (!sendRes.ok || !sendData.success) {
    return {
      status: sendRes.ok ? 422 : sendRes.status,
      data: {
        ok: false,
        error: (sendData.error as string) || `Send failed ${sendRes.status}`,
        send_result: sendData,
      },
    };
  }

  await sb.from("radio_targets").update({
    pitch_status: "pitched",
    pitched_at: new Date().toISOString(),
    last_contact_at: new Date().toISOString(),
  }).eq("station_id", stationId);

  return {
    status: 200,
    data: {
      ok: true,
      sent: true,
      channel: "email",
      pitch_id: pitchLogId,
      message_id: sendData.message_id ?? null,
      to: email,
      station_call_sign: target.station_call_sign,
      cooldown_until: cooldownAfter,
    },
  };
}

export async function runPatchRadioTarget(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const stationId = String(body.station_id ?? "").trim();
  if (!stationId) return { status: 400, data: { error: "station_id required" } };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.contact_email !== undefined) {
    const em = String(body.contact_email ?? "").trim();
    patch.contact_email = em || null;
    if (em) patch.submission_method = "email";
  }
  if (body.contact_name !== undefined) patch.contact_name = String(body.contact_name ?? "").trim() || null;
  if (body.contact_url !== undefined) patch.contact_url = String(body.contact_url ?? "").trim() || null;
  if (body.notes !== undefined) patch.notes = String(body.notes ?? "").trim() || null;
  if (body.pitch_status !== undefined) patch.pitch_status = String(body.pitch_status ?? "").trim() || "not_pitched";
  if (body.submission_method !== undefined) {
    patch.submission_method = String(body.submission_method ?? "").trim() || null;
  }

  if (Object.keys(patch).length <= 1) {
    return { status: 400, data: { error: "Nothing to patch (contact_email, contact_name, notes, pitch_status)" } };
  }

  const { data, error } = await sb.from("radio_targets").update(patch).eq("station_id", stationId)
    .select("station_id, station_call_sign, contact_email, pitch_status").single();
  if (error) return { status: 500, data: { error: error.message } };
  return { status: 200, data: { ok: true, target: data } };
}

export async function runGetRadioPitchLog(body: Record<string, unknown>, sb: SupabaseClient): Promise<RunResult> {
  const limit = Math.min(Number(body.limit) || 50, 200);
  let q = sb.from("radio_pitch_log").select("*").order("created_at", { ascending: false }).limit(limit);
  const stationId = String(body.station_id ?? "").trim();
  if (stationId) q = q.eq("station_id", stationId);
  const { data, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };
  const { count: email24 } = await sb.from("radio_pitch_log").select("*", { count: "exact", head: true })
    .eq("channel", "email").eq("status", "sent")
    .gte("sent_at", new Date(Date.now() - 86400000).toISOString());
  return {
    status: 200,
    data: {
      rows: data ?? [],
      summary: { email_pitches_last_24h: email24 ?? 0 },
    },
  };
}

/** Expand radio_targets.songs_played into apple_station_plays for WoW baseline. */
export async function runBackfillAppleStationBaseline(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  const artistId = await resolveAmfaArtistId(sb, String(body.artist_id ?? ""));
  if (!artistId) {
    return { status: 400, data: { error: "artist_id required (body, AMFA_ARTIST_ID env, or artist_config amfa_artist_id)" } };
  }

  const snapshotWeek = String(body.snapshot_week ?? "").trim() || mondayOf(
    body.snapshot_date ? new Date(String(body.snapshot_date)) : new Date("2026-05-30"),
  );

  const { data: targets, error: tErr } = await sb.from("radio_targets").select("*");
  if (tErr) return { status: 500, data: { error: tErr.message } };

  const playRows: Record<string, unknown>[] = [];
  let skippedNoSong = 0;
  for (const t of targets ?? []) {
    const songs = parseSongsPlayed(t.songs_played);
    for (const s of songs) {
      const spins = Number(s.spins) || 0;
      if (!spins) continue;
      const songId = await resolvePlaySongId(s);
      if (!songId) {
        skippedNoSong++;
        continue;
      }
      playRows.push({
        artist_id: artistId,
        song_id: songId,
        song_name: s.song_name ?? null,
        station_id: t.station_id,
        station_call_sign: t.station_call_sign,
        city: t.city,
        area_name: t.area_name,
        country_code: t.country_code,
        timezone: t.timezone,
        spins_total: spins,
        snapshot_week: snapshotWeek,
        metadata: songId.startsWith("backfill-name:")
          ? { source: "backfill_songs_played", lossy: true }
          : {},
      });
    }
  }

  if (!playRows.length) {
    return {
      status: 400,
      data: {
        error: "No songs_played rows on radio_targets to backfill",
        hint: "Expected [{song_name, spins}] or [{song_id, song_name, spins}]",
        skipped_no_song: skippedNoSong,
      },
    };
  }

  const { error: upErr } = await sb.from("apple_station_plays")
    .upsert(playRows, { onConflict: "song_id,station_id,snapshot_week" });
  if (upErr) return { status: 500, data: { error: upErr.message } };

  const totalSpins = playRows.reduce((sum, r) => sum + Number(r.spins_total), 0);
  const stations = new Set(playRows.map((r) => r.station_id));

  return {
    status: 200,
    data: {
      ok: true,
      snapshot_week: snapshotWeek,
      artist_id: artistId,
      plays_upserted: playRows.length,
      stations: stations.size,
      spins_total: totalSpins,
      lossy_song_ids: playRows.some((r) => String(r.song_id).startsWith("backfill-name:")),
    },
  };
}

export async function runEnrichRadioContacts(
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  try {
    const result = await enrichRadioContacts(sb, body);
    return { status: 200, data: { ok: true, ...result } };
  } catch (e) {
    return { status: 500, data: { error: e instanceof Error ? e.message : String(e) } };
  }
}

export async function runRadioAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
  hubKey: string,
): Promise<RunResult> {
  switch (action) {
    case "draft_radio_pitch":
      return runDraftRadioPitch(body, sb);
    case "send_radio_pitch":
      return runSendRadioPitch(body, sb, hubKey);
    case "patch_radio_target":
      return runPatchRadioTarget(body, sb);
    case "get_radio_pitch_log":
      return runGetRadioPitchLog(body, sb);
    case "backfill_apple_station_baseline":
      return runBackfillAppleStationBaseline(body, sb);
    case "enrich_radio_contacts":
      return runEnrichRadioContacts(body, sb);
    default:
      return { status: 400, data: { error: `Unknown radio action: ${action}` } };
  }
}
