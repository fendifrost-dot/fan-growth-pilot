/**
 * Token-free curator-response logging for routines (e.g. the Gmail reply digest).
 *
 * The caller sends what it read in the reply — curator email, song, outcome, a short
 * note and the Gmail reference. The server finds the pitch_log row itself and writes
 * through agh_update_pitch_response, so:
 *   - the write is attributed (agh_pitch_response_events.actor = "log-pitch-response:<source>");
 *   - agh_preserve_pitch_response still applies (notes append, protected outcomes such as
 *     accepted_free_promo / declined_paid_solicitation are never downgraded);
 *   - nothing is sent, approved or drafted.
 *
 * Matching never guesses: exactly one sent pitch for (curator, song) is required, or the
 * caller passes pitch_log_id. Ambiguous or missing matches return candidates, not writes.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const RESPONSE_STATUSES = [
  "replied",
  "declined",
  "placed",
  "accepted_free_promo",
  "paid_solicitation_no_engage",
  "declined_paid_solicitation",
  "auto_ack_under_review",
  "portal_only",
  "blocked",
  "no_response",
] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

const PLACED_STATUSES = new Set(["placed", "accepted_free_promo"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LogResult = { status: number; data: Record<string, unknown> };

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Constant-time string compare for the shared secret. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function validateLogInput(body: Row): { ok: true; input: Row } | { ok: false; error: string } {
  const pitchLogId = str(body.pitch_log_id);
  const email = str(body.curator_email).toLowerCase();
  const track = str(body.track_name);
  const status = str(body.placement_status).toLowerCase();
  const notes = str(body.response_notes);
  const source = str(body.source).slice(0, 60) || "routine";
  if (!pitchLogId && !(email && track)) return { ok: false, error: "pitch_log_id, or curator_email + track_name, required" };
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: "curator_email is not a valid address" };
  if (!(RESPONSE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `placement_status must be one of: ${RESPONSE_STATUSES.join(", ")}` };
  }
  if (!notes) return { ok: false, error: "response_notes required (what the reply said)" };
  if (notes.length > 2000) return { ok: false, error: "response_notes too long (max 2000)" };
  if (!/^[a-z0-9_.:-]+$/i.test(source)) return { ok: false, error: "source must be a short label (letters, digits, _ . : -)" };
  const ref = str(body.source_ref).slice(0, 200);
  return {
    ok: true,
    input: {
      pitch_log_id: pitchLogId || null,
      curator_email: email || null,
      track_name: track || null,
      placement_status: status,
      response_notes: notes,
      source,
      source_ref: ref || null,
      reply_received: typeof body.reply_received === "boolean" ? body.reply_received : status !== "no_response",
      placed: typeof body.placed === "boolean" ? body.placed : PLACED_STATUSES.has(status),
      dry_run: body.dry_run === true,
    },
  };
}

/** Find the single sent pitch for (curator email, song). Never guesses between rows. */
export async function matchPitchLog(
  sb: SupabaseClient,
  input: Row,
): Promise<{ ok: true; row: Row; basis: string } | { ok: false; status: number; code: string; candidates?: Row[]; error?: string }> {
  const cols = "id, playlist_id, track_name, curator_email, status, sent_at, pitched_at, placement_status";
  if (input.pitch_log_id) {
    const { data, error } = await sb.from("pitch_log").select(cols).eq("id", String(input.pitch_log_id)).maybeSingle();
    if (error) return { ok: false, status: 500, code: "db_error", error: error.message };
    if (!data) return { ok: false, status: 404, code: "pitch_log_not_found" };
    return { ok: true, row: data as Row, basis: "pitch_log_id" };
  }
  const email = String(input.curator_email);
  const track = String(input.track_name).toLowerCase();

  // Rows sent to the address directly, plus rows for any playlist whose curator is this
  // address (older rows may lack curator_email on pitch_log).
  const { data: direct, error: dErr } = await sb.from("pitch_log").select(cols).ilike("curator_email", email).limit(200);
  if (dErr) return { ok: false, status: 500, code: "db_error", error: dErr.message };
  const { data: targets, error: tErr } = await sb.from("playlist_targets").select("playlist_id").ilike("curator_email", email).limit(200);
  if (tErr) return { ok: false, status: 500, code: "db_error", error: tErr.message };
  let viaTarget: Row[] = [];
  const pids = ((targets ?? []) as Row[]).map((t) => String(t.playlist_id));
  if (pids.length) {
    const { data, error } = await sb.from("pitch_log").select(cols).in("playlist_id", pids).limit(200);
    if (error) return { ok: false, status: 500, code: "db_error", error: error.message };
    viaTarget = (data ?? []) as Row[];
  }
  const byId = new Map<string, Row>();
  for (const r of [...((direct ?? []) as Row[]), ...viaTarget]) byId.set(String(r.id), r);
  const sent = [...byId.values()].filter((r) => ["sent", "bounced"].includes(String(r.status)));
  const forTrack = sent.filter((r) => String(r.track_name ?? "").toLowerCase() === track);
  const summary = (rs: Row[]) =>
    rs.slice(0, 10).map((r) => ({
      pitch_log_id: r.id, playlist_id: r.playlist_id, track_name: r.track_name,
      sent_at: r.sent_at ?? r.pitched_at, placement_status: r.placement_status,
    }));
  if (!forTrack.length) {
    return { ok: false, status: 404, code: "no_matching_pitch", candidates: summary(sent) };
  }
  if (forTrack.length > 1) {
    return { ok: false, status: 409, code: "ambiguous_pitch", candidates: summary(forTrack) };
  }
  return { ok: true, row: forTrack[0], basis: "curator_email+track_name" };
}

export async function logPitchResponse(sb: SupabaseClient, body: Row): Promise<LogResult> {
  const v = validateLogInput(body);
  if (!v.ok) return { status: 400, data: { ok: false, code: "bad_request", error: v.error } };
  const input = v.input;
  const match = await matchPitchLog(sb, input);
  if (!match.ok) {
    return {
      status: match.status,
      data: {
        ok: false, code: match.code, error: match.error ?? null, candidates: match.candidates ?? [],
        hint: match.code === "ambiguous_pitch" ? "pass pitch_log_id from candidates" : undefined,
      },
    };
  }
  const row = match.row;
  const ref = input.source_ref ? ` (ref ${input.source_ref})` : "";
  const patch = {
    placement_status: input.placement_status,
    reply_received: input.reply_received,
    placed: input.placed,
    response_notes: `[${input.source}] ${input.response_notes}${ref}`,
  };
  if (input.dry_run) {
    return { status: 200, data: { ok: true, dry_run: true, match_basis: match.basis, pitch_log: row, would_apply: patch } };
  }
  const actor = `log-pitch-response:${input.source}`;
  const { data, error } = await sb.rpc("agh_update_pitch_response", { p_id: row.id, p_patch: patch, p_actor: actor });
  if (error) {
    const missing = /could not find the function|PGRST202|42883/i.test(String(error.message));
    return {
      status: missing ? 503 : 500,
      data: {
        ok: false,
        code: missing ? "migration_required" : "db_error",
        error: missing ? "agh_update_pitch_response missing — apply 20260930210000_response_attribution_route_recert.sql" : error.message,
      },
    };
  }
  const res = (data ?? {}) as Row;
  if (res.ok !== true) return { status: 422, data: { ok: false, code: res.code ?? "write_refused", error: res.error ?? null } };
  const after = (res.row ?? {}) as Row;
  return {
    status: 200,
    data: {
      ok: true,
      pitch_log_id: row.id,
      match_basis: match.basis,
      actor,
      requested_placement_status: input.placement_status,
      placement_status: after.placement_status ?? null,
      // The preserve trigger keeps protected outcomes (e.g. accepted_free_promo) — say so.
      status_preserved: after.placement_status != null && after.placement_status !== input.placement_status,
      placed: after.placed ?? null,
      reply_received: after.reply_received ?? null,
    },
  };
}
