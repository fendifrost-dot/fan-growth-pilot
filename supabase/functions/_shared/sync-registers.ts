// Operator-only song flags + music-supervisor roster + licensing pitch log.
// Mirrors playlist pitch_log: who was pitched, when, whether they responded.
// No send path — recording only. Licensing log starts empty (no seed rows).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  assertHouseElectronicStampAllowed,
  computeSyncEligible as computeSyncEligibleFromRules,
} from "./catalog-rules.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const EVEN_ARTIST_URL = "https://www.even.biz/artists/fendi-frost";
export const MONTH1_SYNC_DEFAULT_TITLE = "Meditate";

const AGGREGATORS = new Set(["distrokid", "tunecore", "orchard", "open"]);
const SAMPLE_FLAGS = new Set(["yes", "no", "unknown"]);
const GENRE_STAMPS = new Set(["hip_hop_rap", "house_electronic", "unknown"]);
const RESPONSES = new Set(["awaiting", "replied", "licensed", "declined"]);

export const SYNC_REGISTER_ACTIONS = [
  "list_music_supervisors",
  "upsert_music_supervisor",
  "delete_music_supervisor",
  "list_licensing_pitches",
  "log_licensing_pitch",
  "mark_licensing_response",
] as const;

export function isSyncRegisterAction(action: string): boolean {
  return (SYNC_REGISTER_ACTIONS as readonly string[]).includes(action);
}

export function normalizeTitle(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isMeditateTitle(name: string | null | undefined): boolean {
  return normalizeTitle(name) === "meditate";
}

/** Sample alone never grants sync eligibility. */
export function computeSyncEligible(hasSample: string | null | undefined): boolean {
  return computeSyncEligibleFromRules(hasSample);
}

/**
 * Write-boundary genre stamp gate. trackId is required for house_electronic.
 * @deprecated Prefer assertHouseElectronicStampAllowed(trackId, genre) directly.
 */
export function assertGenreStampAllowed(
  name: string,
  genreStamp: string,
  trackId?: string | null,
): { ok: true } | { ok: false; error: string } {
  if (genreStamp === "house_electronic") {
    return assertHouseElectronicStampAllowed(trackId, genreStamp);
  }
  if (isMeditateTitle(name) && genreStamp === "house_electronic") {
    return { ok: false, error: "Meditate is Hip-Hop/Rap — never stamp it house / deep house." };
  }
  return { ok: true };
}

export function parseAggregator(v: unknown): string {
  const s = String(v ?? "open").trim().toLowerCase();
  return AGGREGATORS.has(s) ? s : "open";
}

export function parseSampleFlag(v: unknown): string {
  const s = String(v ?? "unknown").trim().toLowerCase();
  return SAMPLE_FLAGS.has(s) ? s : "unknown";
}

export function parseGenreStamp(v: unknown): string {
  const s = String(v ?? "unknown").trim().toLowerCase();
  return GENRE_STAMPS.has(s) ? s : "unknown";
}

export function parseLicensingResponse(v: unknown): string {
  const s = String(v ?? "awaiting").trim().toLowerCase();
  return RESPONSES.has(s) ? s : "awaiting";
}

export function patchForLicensingResponse(c: string): {
  reply_received: boolean;
  placed: boolean;
  response_status: string;
} {
  if (c === "licensed") return { reply_received: true, placed: true, response_status: "licensed" };
  if (c === "replied") return { reply_received: true, placed: false, response_status: "replied" };
  if (c === "declined") return { reply_received: true, placed: false, response_status: "declined" };
  return { reply_received: false, placed: false, response_status: "awaiting" };
}

/** Fields catalogue upsert may write. House stamp gated by exact track_id. */
export function trackSyncFields(
  body: Record<string, unknown>,
  name: string,
  trackId?: string | null,
): Record<string, unknown> | { error: string } {
  const fields: Record<string, unknown> = {};
  const id = trackId ?? (body.id ? String(body.id) : null);
  if (body.aggregator !== undefined) fields.aggregator = parseAggregator(body.aggregator);
  if (body.genre_stamp !== undefined) {
    const genre = parseGenreStamp(body.genre_stamp);
    const gate = assertGenreStampAllowed(name, genre, id);
    if (!gate.ok) return { error: gate.error };
    fields.genre_stamp = genre;
  }
  if (body.has_sample !== undefined) fields.has_sample = parseSampleFlag(body.has_sample);
  // Never accept client writes that set sync_eligible true from sample alone.
  if (body.sync_eligible !== undefined) {
    return { error: "sync_eligible is not writable from catalogue upsert; use the sync gate / Fendi approval path." };
  }
  if (typeof body.is_month1_sync_default === "boolean") {
    fields.is_month1_sync_default = body.is_month1_sync_default;
  }
  return fields;
}

export function stripIsrcFromRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const { isrc: _i, ...rest } = r;
    return rest;
  });
}

export async function runSyncRegisterAction(
  action: string,
  body: Record<string, unknown>,
  sb: SupabaseClient,
): Promise<RunResult> {
  if (action === "list_music_supervisors") {
    const { data, error } = await sb
      .from("music_supervisors")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "upsert_music_supervisor") {
    const id = body.id ? String(body.id) : null;
    const name = String(body.name ?? "").trim();
    if (!name) return { status: 400, data: { error: "name required" } };
    const fields = {
      name,
      company: String(body.company ?? "").trim() || null,
      email: String(body.email ?? "").trim().toLowerCase() || null,
      notes: String(body.notes ?? "").trim() || null,
      source: String(body.source ?? "").trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (id) {
      const { data, error } = await sb.from("music_supervisors").update(fields).eq("id", id).select().single();
      if (error) return { status: 500, data: { error: error.message } };
      return { status: 200, data: { ok: true, row: data } };
    }
    const { data, error } = await sb.from("music_supervisors").insert(fields).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "delete_music_supervisor") {
    const id = String(body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "id required" } };
    const { error } = await sb.from("music_supervisors").delete().eq("id", id);
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true } };
  }

  if (action === "list_licensing_pitches") {
    const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
    const trackName = String(body.track_name ?? "").trim();
    const onlyPending = Boolean(body.only_pending_response);
    let q = sb.from("licensing_pitch_log").select("*").order("pitched_at", { ascending: false }).limit(limit);
    if (trackName) q = q.ilike("track_name", `%${trackName}%`);
    if (onlyPending) q = q.eq("reply_received", false).eq("placed", false);
    const { data, error } = await q;
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, rows: data ?? [] } };
  }

  if (action === "log_licensing_pitch") {
    let contactName = String(body.contact_name ?? "").trim();
    let contactEmail = String(body.contact_email ?? "").trim().toLowerCase() || null;
    let company = String(body.company ?? "").trim() || null;
    const supervisorId = body.supervisor_id ? String(body.supervisor_id) : null;
    if (supervisorId) {
      const { data: sup, error: sErr } = await sb.from("music_supervisors").select("*").eq("id", supervisorId).maybeSingle();
      if (sErr) return { status: 500, data: { error: sErr.message } };
      if (!sup) return { status: 404, data: { error: "supervisor not found" } };
      contactName = contactName || String(sup.name ?? "");
      contactEmail = contactEmail || (sup.email ? String(sup.email) : null);
      company = company || (sup.company ? String(sup.company) : null);
    }
    if (!contactName) return { status: 400, data: { error: "contact_name (or supervisor_id) required" } };

    let trackId = body.track_id ? String(body.track_id) : null;
    let trackName = String(body.track_name ?? "").trim();
    if (trackId) {
      const { data: tr, error: tErr } = await sb.from("tracks").select("id, name").eq("id", trackId).maybeSingle();
      if (tErr) return { status: 500, data: { error: tErr.message } };
      if (!tr) return { status: 404, data: { error: "track not found" } };
      trackName = String(tr.name);
    } else if (trackName) {
      const { data: tr } = await sb.from("tracks").select("id, name").ilike("name", trackName).maybeSingle();
      if (tr) {
        trackId = String(tr.id);
        trackName = String(tr.name);
      }
    }
    if (!trackName) return { status: 400, data: { error: "track_name or track_id required" } };

    const response = parseLicensingResponse(body.response_status);
    const flags = patchForLicensingResponse(response);
    const pitchedAt = typeof body.pitched_at === "string" && body.pitched_at.trim()
      ? body.pitched_at
      : new Date().toISOString();

    const { data, error } = await sb.from("licensing_pitch_log").insert({
      supervisor_id: supervisorId,
      contact_name: contactName,
      contact_email: contactEmail,
      company,
      track_id: trackId,
      track_name: trackName,
      pitched_at: pitchedAt,
      status: "sent",
      reply_received: flags.reply_received,
      placed: flags.placed,
      response_status: flags.response_status,
      response_notes: typeof body.response_notes === "string" ? body.response_notes.trim() || null : null,
    }).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  if (action === "mark_licensing_response") {
    const id = String(body.licensing_pitch_id ?? body.id ?? "").trim();
    if (!id) return { status: 400, data: { error: "licensing_pitch_id required" } };
    const patch: Record<string, unknown> = {};
    if (typeof body.response_status === "string") {
      Object.assign(patch, patchForLicensingResponse(parseLicensingResponse(body.response_status)));
    }
    if (typeof body.reply_received === "boolean") patch.reply_received = body.reply_received;
    if (typeof body.placed === "boolean") patch.placed = body.placed;
    if (typeof body.response_notes === "string") patch.response_notes = body.response_notes.trim() || null;
    if (!Object.keys(patch).length) {
      return { status: 400, data: { error: "Nothing to update (response_status | reply_received | placed | response_notes)" } };
    }
    const { data, error } = await sb.from("licensing_pitch_log").update(patch).eq("id", id).select().single();
    if (error) return { status: 500, data: { error: error.message } };
    return { status: 200, data: { ok: true, row: data } };
  }

  return { status: 400, data: { error: `Unknown sync-register action: ${action}` } };
}
