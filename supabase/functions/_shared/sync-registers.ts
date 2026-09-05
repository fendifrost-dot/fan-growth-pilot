// Operator-only song flags + music-supervisor roster + licensing pitch log.
// Mirrors playlist pitch_log: who was pitched, when, whether they responded.
// No send path — recording only. Licensing log starts empty (no seed rows).
// Genre stamps are never gated by display-title literals.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { denyUnlessCan, type OpsActor } from "./ops-actors.ts";

export type RunResult = { status: number; data: Record<string, unknown> };

export const EVEN_ARTIST_URL = "https://www.even.biz/artists/fendi-frost";

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
  "get_track_sync_gate",
  "update_track_sync_gate",
  "recompute_track_sync_eligible",
] as const;

export function isSyncRegisterAction(action: string): boolean {
  return (SYNC_REGISTER_ACTIONS as readonly string[]).includes(action);
}

export function normalizeTitle(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Sample alone never grants sync eligibility — use the Sync Gate / Fendi path. */
export function computeSyncEligible(_hasSample: string | null | undefined): boolean {
  return false;
}

function isRapPrimary(v: string | null | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "hip_hop_rap" || s === "rap" || s.includes("hip-hop") || s.includes("hip hop");
}

export function assertGenreStampAllowed(opts: {
  genreStamp: string;
  currentStamp?: string | null;
  approvedPrimaryGenre?: string | null;
}): { ok: true } | { ok: false; error: string } {
  if (opts.genreStamp !== "house_electronic") return { ok: true };
  if (isRapPrimary(opts.approvedPrimaryGenre) || opts.currentStamp === "hip_hop_rap") {
    return {
      ok: false,
      error:
        "house_electronic stamp contradicts this track’s rap / hip-hop identity (current stamp or approved Song DNA).",
    };
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

/** Fields catalogue upsert may write. Only applied when the caller sent them. */
export function trackSyncFields(
  body: Record<string, unknown>,
  opts?: { currentStamp?: string | null; approvedPrimaryGenre?: string | null },
): Record<string, unknown> | { error: string } {
  const fields: Record<string, unknown> = {};
  if (body.aggregator !== undefined) fields.aggregator = parseAggregator(body.aggregator);
  if (body.genre_stamp !== undefined) {
    const genre = parseGenreStamp(body.genre_stamp);
    const gate = assertGenreStampAllowed({
      genreStamp: genre,
      currentStamp: opts?.currentStamp ?? null,
      approvedPrimaryGenre: opts?.approvedPrimaryGenre ?? null,
    });
    if (!gate.ok) return { error: gate.error };
    fields.genre_stamp = genre;
  }
  if (body.has_sample !== undefined) fields.has_sample = parseSampleFlag(body.has_sample);
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
  opsActor: OpsActor | null = null,
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

  if (action === "get_track_sync_gate") {
    const trackId = String(body.track_id ?? "").trim();
    if (!trackId) return { status: 400, data: { error: "track_id required" } };
    const { data: track, error } = await sb
      .from("tracks")
      .select(
        "id, name, has_sample, sync_eligible, approved_song_dna_version_id, sample_declaration_approved_at, sync_approved_at, splits_ready, publishing_ready, assets_ready, unresolved_rights_exception, sample_exception_resolved, sync_eligible_blockers, sync_eligible_computed_at",
      )
      .eq("id", trackId)
      .maybeSingle();
    if (error) return { status: 500, data: { error: error.message } };
    if (!track) return { status: 404, data: { error: "track not found" } };
    return { status: 200, data: { ok: true, track } };
  }

  if (action === "update_track_sync_gate") {
    const trackId = String(body.track_id ?? "").trim();
    if (!trackId) return { status: 400, data: { error: "track_id required" } };
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {};

    const wantsSampleDecision = body.sample_declaration_approved === true || body.sample_declaration_approved === false;
    const wantsSyncDecision = body.sync_approved === true || body.sync_approved === false;

    if (wantsSampleDecision) {
      const denied = denyUnlessCan(opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" }, "approve_sample_declaration");
      if (denied) return denied;
      if (!opsActor || opsActor.kind !== "fendi") {
        return {
          status: 403,
          data: { error: "Only Fendi's exact ARTIST_USER_ID may approve sample declarations" },
        };
      }
      if (body.sample_declaration_approved === true) {
        patch.sample_declaration_approved_at = now;
        patch.sample_declaration_approved_by = opsActor.userId;
      } else {
        patch.sample_declaration_approved_at = null;
        patch.sample_declaration_approved_by = null;
      }
    }

    if (wantsSyncDecision) {
      const denied = denyUnlessCan(opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" }, "approve_sync_eligibility");
      if (denied) return denied;
      if (!opsActor || opsActor.kind !== "fendi") {
        return {
          status: 403,
          data: { error: "Only Fendi's exact ARTIST_USER_ID may approve sync eligibility" },
        };
      }
      if (body.sync_approved === true) {
        patch.sync_approved_at = now;
        patch.sync_approved_by = opsActor.userId;
      } else {
        patch.sync_approved_at = null;
        patch.sync_approved_by = null;
      }
    }

    const wantsOpsFlags =
      typeof body.splits_ready === "boolean" ||
      typeof body.publishing_ready === "boolean" ||
      typeof body.assets_ready === "boolean" ||
      typeof body.unresolved_rights_exception === "boolean" ||
      typeof body.sample_exception_resolved === "boolean";

    if (wantsOpsFlags) {
      const denied = denyUnlessCan(
        opsActor ?? { kind: "anonymous", userId: null, label: "anonymous" },
        "update_sync_gate_ops_flags",
      );
      if (denied) return denied;
      if (typeof body.splits_ready === "boolean") patch.splits_ready = body.splits_ready;
      if (typeof body.publishing_ready === "boolean") patch.publishing_ready = body.publishing_ready;
      if (typeof body.assets_ready === "boolean") patch.assets_ready = body.assets_ready;
      if (typeof body.unresolved_rights_exception === "boolean") {
        patch.unresolved_rights_exception = body.unresolved_rights_exception;
      }
      if (typeof body.sample_exception_resolved === "boolean") {
        patch.sample_exception_resolved = body.sample_exception_resolved;
      }
    }

    if (!Object.keys(patch).length) {
      return {
        status: 400,
        data: {
          error:
            "Provide at least one gate field (sample_declaration_approved | sync_approved | splits_ready | publishing_ready | assets_ready | unresolved_rights_exception | sample_exception_resolved)",
        },
      };
    }

    const { error: upErr } = await sb.from("tracks").update(patch).eq("id", trackId);
    if (upErr) return { status: 500, data: { error: upErr.message } };

    try {
      const { recomputeTrackSyncEligible } = await import("./sync-eligibility.ts");
      const result = await recomputeTrackSyncEligible(sb, trackId);
      return { status: 200, data: { ok: true, ...result } };
    } catch (e) {
      return { status: 500, data: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  if (action === "recompute_track_sync_eligible") {
    const trackId = String(body.track_id ?? "").trim();
    if (!trackId) return { status: 400, data: { error: "track_id required" } };
    try {
      const { recomputeTrackSyncEligible } = await import("./sync-eligibility.ts");
      const result = await recomputeTrackSyncEligible(sb, trackId);
      return { status: 200, data: { ok: true, ...result } };
    } catch (e) {
      return { status: 500, data: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  return { status: 400, data: { error: `Unknown sync-register action: ${action}` } };
}
