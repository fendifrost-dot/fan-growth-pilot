/**
 * Shared submission-ROUTE eligibility — one rule set used at every boundary:
 * discovery verification, inventory creation, Grok approval, and manual/email send.
 *
 * Route verification is a separate question from:
 *   - identity verification (is this a real playlist? → playlist_id / identity_resolved)
 *   - song fit (does the approved Song DNA allow this lane? → track-dna-envelope)
 *   - submission terms (free/paid → submission_cost / form_cost; unknown stays unknown)
 *
 * A verified playlist identity or a good genre fit NEVER implies a usable route.
 * A syntactically valid URL alone is NOT a verified form: the form must not be a
 * listening/platform page (Spotify, Apple Music, …) and the evidence must not state
 * that no route was found.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type RouteChannel = "email" | "web_form" | "instagram_dm";

export type RouteAssessment = {
  ok: boolean;
  channel: RouteChannel | null;
  /** Machine code; "route_ok" when ok. */
  code: string;
  reason: string;
  /** The route value that was assessed (email / form URL / IG handle). */
  route: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IG_HANDLE_RE = /^@?[A-Za-z0-9._]{2,30}$/;

/**
 * Hosts whose pages are listening/profile pages, never curator submission forms.
 * Spotify has no curator submission form at all; the others are listening surfaces.
 * Legitimate third-party submission services (e.g. Soundplate, DailyPlaylists,
 * SubmitHub, Google/Typeform/Jotform forms) are NOT listed and are judged on evidence.
 */
const NON_FORM_HOSTS = [
  "open.spotify.com",
  "play.spotify.com",
  "spotify.com",
  "spotify.link",
  "spoti.fi",
  "music.apple.com",
  "music.youtube.com",
  "deezer.com",
  "deezer.page.link",
  "tidal.com",
  "listen.tidal.com",
];

/** Evidence phrases that explicitly say no route exists / was confirmed. */
const NEGATED_ROUTE_EVIDENCE = [
  /\bno (submission )?(route|path|form|contact|email)s? (was |were )?(confirmed|found|available|listed|located|identified)\b/i,
  /\bno submission (route|path|form|option|method)\b/i,
  /\b(route|form|submission|contact) (is |was )?(not |un)(confirmed|verified|found|available)\b/i,
  /\bnot accepting submissions\b/i,
  /\bsubmissions? (are |is )?closed\b/i,
  /\bno (public )?(way|means) to submit\b/i,
];

export function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isNonFormHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  return NON_FORM_HOSTS.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

export function isSpotifyUrl(url: string): boolean {
  const h = hostOf(url);
  return !!h && (h === "spotify.com" || h.endsWith(".spotify.com") || h === "spotify.link" ||
    h === "spoti.fi");
}

export function evidenceNegatesRoute(evidence: string | null | undefined): boolean {
  const e = String(evidence ?? "");
  return NEGATED_ROUTE_EVIDENCE.some((re) => re.test(e));
}

function blank(v: unknown): boolean {
  return v == null || String(v).trim() === "";
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function normalizeChannel(v: unknown): RouteChannel | null {
  const c = str(v).toLowerCase();
  return c === "email" || c === "web_form" || c === "instagram_dm" ? c : null;
}

/**
 * Pure route check for one channel. Input is a playlist_targets row, a handoff packet,
 * or a candidate — whichever carries the route fields.
 *
 * Web form requires: http(s) form URL, not a listening/platform page, not equal to the
 * playlist's own URL, and non-empty evidence that does not say no route was confirmed.
 * Email requires a well-formed address (deliverability is checked separately, DB-backed).
 * IG requires a valid handle plus non-negated evidence.
 */
export function assessSubmissionRoute(
  input: Record<string, unknown>,
  channelHint?: string | null,
): RouteAssessment {
  const channel = normalizeChannel(channelHint) ??
    normalizeChannel(input.submission_channel) ??
    normalizeChannel(input.channel) ??
    normalizeChannel(input.contact_method) ??
    normalizeChannel(input.submission_method);

  if (!channel) {
    return {
      ok: false,
      channel: null,
      code: "no_route_channel",
      reason: "no submission channel selected (email, web_form or instagram_dm)",
      route: null,
    };
  }

  if (channel === "email") {
    const email = str(input.curator_email ?? input.recipient);
    if (!email) {
      return { ok: false, channel, code: "missing_curator_email", reason: "email route has no curator_email", route: null };
    }
    if (!EMAIL_RE.test(email)) {
      return { ok: false, channel, code: "invalid_curator_email", reason: `curator_email is not a valid address: ${email}`, route: email };
    }
    return { ok: true, channel, code: "route_ok", reason: "email address present", route: email.toLowerCase() };
  }

  if (channel === "web_form") {
    // Only form_url counts. submission_url is legacy and frequently holds the playlist's
    // own Spotify URL, so it is accepted only when it is itself a non-platform page.
    const formUrl = str(input.form_url) || str(input.submission_url);
    if (!formUrl) {
      return { ok: false, channel, code: "missing_form_url", reason: "web_form route has no form_url", route: null };
    }
    if (!/^https?:\/\/.+/i.test(formUrl) || !hostOf(formUrl)) {
      return { ok: false, channel, code: "invalid_form_url", reason: `form_url is not an http(s) URL: ${formUrl}`, route: formUrl };
    }
    if (isNonFormHost(formUrl)) {
      return {
        ok: false,
        channel,
        code: isSpotifyUrl(formUrl) ? "spotify_url_as_form" : "platform_url_as_form",
        reason: `form_url is a listening/platform page, not a submission form: ${formUrl}`,
        route: formUrl,
      };
    }
    const playlistUrl = str(input.playlist_url);
    if (playlistUrl && playlistUrl.replace(/\/+$/, "") === formUrl.replace(/\/+$/, "")) {
      return { ok: false, channel, code: "playlist_url_as_form", reason: "form_url is the playlist's own URL", route: formUrl };
    }
    const evidence = str(input.form_source_evidence ?? input.source_evidence ?? input.evidence);
    if (!evidence) {
      return { ok: false, channel, code: "missing_form_evidence", reason: "web_form route has no source evidence", route: formUrl };
    }
    if (evidenceNegatesRoute(evidence)) {
      return {
        ok: false,
        channel,
        code: "evidence_negates_route",
        reason: "source evidence states no submission route was confirmed",
        route: formUrl,
      };
    }
    return { ok: true, channel, code: "route_ok", reason: "web form URL with supporting evidence", route: formUrl };
  }

  // instagram_dm
  const handle = str(input.ig_curator_account ?? input.curator_instagram);
  if (!handle) {
    return { ok: false, channel, code: "missing_ig_account", reason: "instagram_dm route has no curator account", route: null };
  }
  if (!IG_HANDLE_RE.test(handle)) {
    return { ok: false, channel, code: "invalid_ig_account", reason: `curator Instagram account is invalid: ${handle}`, route: handle };
  }
  const evidence = str(input.ig_source_evidence ?? input.source_evidence ?? input.evidence);
  if (!evidence) {
    return { ok: false, channel, code: "missing_ig_evidence", reason: "instagram_dm route has no source evidence", route: handle };
  }
  if (evidenceNegatesRoute(evidence)) {
    return { ok: false, channel, code: "evidence_negates_route", reason: "source evidence states no submission route was confirmed", route: handle };
  }
  return { ok: true, channel, code: "route_ok", reason: "IG curator account with supporting evidence", route: handle.replace(/^@/, "").toLowerCase() };
}

/**
 * Boundary check used by inventory, approval and send paths: the target must be
 * path_verified with a verified status AND its stored route must still pass
 * assessSubmissionRoute for the packet's channel. Catches records verified by the
 * old (defective) rules.
 */
export function assertSubmissionReady(
  target: Record<string, unknown> | null | undefined,
  channel?: string | null,
): RouteAssessment {
  if (!target) {
    return { ok: false, channel: normalizeChannel(channel), code: "target_missing", reason: "playlist target not found", route: null };
  }
  const status = str(target.verification_status).toLowerCase();
  const effectiveChannel = normalizeChannel(channel) ??
    normalizeChannel(target.contact_method) ?? normalizeChannel(target.submission_method);
  // Email deliverability is established by verifyEmail → verification_status (legacy email
  // targets predate path_verified). Form/IG routes have no such check, so the explicit
  // path_verified flag is required for them.
  const flagRequired = effectiveChannel !== "email";
  if ((flagRequired && target.path_verified !== true) || !["auto_verified", "manually_verified"].includes(status)) {
    return {
      ok: false,
      channel: normalizeChannel(channel),
      code: "route_not_verified",
      reason: `target route is not verified (path_verified=${String(target.path_verified)}, verification_status=${status || "null"})`,
      route: null,
    };
  }
  return assessSubmissionRoute(target, channel);
}

/** Hold marker written into path_verification_notes when a route fails re-check. */
export const ROUTE_HOLD_PREFIX = "ROUTE_HOLD:";

export function isBlank(v: unknown): boolean {
  return blank(v);
}

// ---------------------------------------------------------------------------
// DB-aware boundary helpers (approval, manual submit, email approve/send, batch advance).
// ---------------------------------------------------------------------------

type SbLike = SupabaseClient;

export const TARGET_ROUTE_COLUMNS =
  "playlist_id, verification_status, path_verified, path_verification_notes, contact_method, submission_method, curator_email, form_url, submission_url, ig_curator_account, curator_instagram, form_source_evidence, ig_source_evidence, submission_cost, form_cost";

export type SubmissionTerms = "free" | "paid" | "tip_appreciated" | "unknown";

/** Free/paid terms stay explicit; anything unrecorded is "unknown", never assumed free. */
export function submissionTerms(target: Record<string, unknown> | null | undefined): SubmissionTerms {
  const c = str(target?.submission_cost).toLowerCase();
  if (c === "free" || c === "paid" || c === "tip_appreciated") return c;
  return "unknown";
}

export type TargetReadiness = RouteAssessment & {
  playlist_id: string;
  submission_terms: SubmissionTerms;
  query_error?: string;
};

/** Load the target and apply assertSubmissionReady. Query errors fail closed. */
export async function checkTargetSubmissionReady(
  sb: SbLike,
  playlistId: string | null | undefined,
  channel?: string | null,
  /** e.g. { curator_email: draft.recipient } — the address that will actually be emailed. */
  overrides?: Record<string, unknown>,
): Promise<TargetReadiness> {
  const pid = str(playlistId);
  if (!pid) {
    return { ok: false, channel: normalizeChannel(channel), code: "missing_playlist_id", reason: "no playlist target on record", route: null, playlist_id: "", submission_terms: "unknown" };
  }
  const { data, error } = await sb.from("playlist_targets").select(TARGET_ROUTE_COLUMNS).eq("playlist_id", pid).maybeSingle();
  if (error) {
    return { ok: false, channel: normalizeChannel(channel), code: "route_check_failed", reason: `route check query failed: ${error.message}`, route: null, playlist_id: pid, submission_terms: "unknown", query_error: String(error.message) };
  }
  const effective = data
    ? { ...(data as Record<string, unknown>), ...Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => !blank(v))) }
    : null;
  const verdict = assertSubmissionReady(effective, channel);
  return { ...verdict, playlist_id: pid, submission_terms: submissionTerms(data as Record<string, unknown> | null) };
}

/** A record the route audit / approval boundary put on hold (packet.route_hold). */
export function recordRouteHold(record: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const packet = (record?.packet ?? null) as Record<string, unknown> | null;
  const hold = packet?.route_hold;
  return hold && typeof hold === "object" ? hold as Record<string, unknown> : null;
}

/** Route fields a packet carries for its channel, refreshed from the (repaired) target. */
export function packetRouteFields(target: Record<string, unknown>, channel: string | null): Record<string, unknown> {
  if (channel === "email") return { curator_email: str(target.curator_email).toLowerCase() || null };
  if (channel === "web_form") return { form_url: str(target.form_url) || null };
  if (channel === "instagram_dm") return { ig_curator_account: str(target.ig_curator_account ?? target.curator_instagram) || null };
  return {};
}

/**
 * Release route holds on a target's open records once the target's route passes again.
 * Only clears the hold marker and refreshes the packet's route fields; the record stays in
 * its Claude-side repair batch until advance_playlist_batches sends it back to Grok.
 */
export async function releaseRouteHoldsForTarget(
  sb: SbLike,
  playlistId: string,
  releasedBy: string,
): Promise<{ released: string[]; still_held: string[]; error?: string }> {
  const { data: target, error: tErr } = await sb.from("playlist_targets").select(TARGET_ROUTE_COLUMNS).eq("playlist_id", playlistId).maybeSingle();
  if (tErr) return { released: [], still_held: [], error: tErr.message };
  const { data: recs, error: rErr } = await sb
    .from("agh_handoff_records")
    .select("id, packet, submission_channel, queue_state, submitted_at")
    .eq("playlist_target_id", playlistId);
  if (rErr) return { released: [], still_held: [], error: rErr.message };
  const released: string[] = [];
  const stillHeld: string[] = [];
  for (const r of (recs ?? []) as Record<string, unknown>[]) {
    const hold = recordRouteHold(r);
    if (!hold || r.submitted_at) continue;
    const channel = str(r.submission_channel) || null;
    const verdict = assertSubmissionReady(target as Record<string, unknown> | null, channel);
    if (!verdict.ok) {
      stillHeld.push(String(r.id));
      continue;
    }
    const packet = { ...((r.packet ?? {}) as Record<string, unknown>) };
    delete packet.route_hold;
    Object.assign(packet, packetRouteFields(target as Record<string, unknown>, channel));
    packet.route_hold_released = { at: new Date().toISOString(), by: releasedBy, prior: hold };
    const { error: uErr } = await sb
      .from("agh_handoff_records")
      .update({ packet, updated_at: new Date().toISOString() })
      .eq("id", r.id);
    if (uErr) return { released, still_held: stillHeld, error: uErr.message };
    released.push(String(r.id));
  }
  return { released, still_held: stillHeld };
}

/**
 * Route-check every open record of a batch. Failing records are moved to a Claude-side
 * repair batch via agh_route_hold_records (SQL) so the rest of the batch keeps moving.
 * Fails closed (ok:false) when the check or the hold RPC is unavailable.
 */
export async function holdFailingRecordsInBatch(
  sb: SbLike,
  batchId: string,
  heldBy: string,
): Promise<{ ok: boolean; held: Record<string, unknown>[]; checked: number; error?: string; code?: string }> {
  const { data: recs, error } = await sb
    .from("agh_handoff_records")
    .select("id, playlist_target_id, submission_channel, queue_state, submitted_at, packet, record_kind")
    .eq("batch_id", batchId);
  if (error) return { ok: false, held: [], checked: 0, error: error.message, code: "route_check_failed" };
  const failing: Record<string, unknown>[] = [];
  let checked = 0;
  for (const r of (recs ?? []) as Record<string, unknown>[]) {
    if (r.submitted_at || r.record_kind !== "playlist_target") continue;
    checked++;
    const v = await checkTargetSubmissionReady(sb, str(r.playlist_target_id), str(r.submission_channel) || null);
    if (v.query_error) return { ok: false, held: [], checked, error: v.query_error, code: "route_check_failed" };
    if (!v.ok || recordRouteHold(r)) {
      failing.push({
        record_id: r.id,
        code: v.ok ? String(recordRouteHold(r)?.code ?? "route_hold") : v.code,
        reason: v.ok ? "record still carries an unresolved route hold" : v.reason,
        playlist_target_id: r.playlist_target_id,
      });
    }
  }
  if (!failing.length) return { ok: true, held: [], checked };
  const { data, error: rpcErr } = await sb.rpc("agh_route_hold_records", { p_items: failing, p_held_by: heldBy });
  if (rpcErr) {
    const missing = /could not find|does not exist|PGRST202/i.test(String(rpcErr.message ?? ""));
    return {
      ok: false,
      held: failing,
      checked,
      error: missing ? "agh_route_hold_records RPC unavailable — apply migration 20260927120000" : String(rpcErr.message),
      code: missing ? "migration_required" : "route_hold_failed",
    };
  }
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok === false) {
    return { ok: false, held: failing, checked, error: String(result.error ?? "route hold rejected"), code: "route_hold_failed" };
  }
  return { ok: true, held: (result.held as Record<string, unknown>[]) ?? failing, checked };
}
