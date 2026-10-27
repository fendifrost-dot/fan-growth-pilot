/**
 * Shared pre-send gate for playlist email and the Muse Instagram DM queue.
 *
 * A row is sendable only when every check holds. Missing, unknown, and stale
 * evidence are named blockers. Pitch copy is returned on `dispatch` only when
 * `sendable` is true — a refusal never echoes a body, subject, or recipient.
 *
 * Route freshness is PRE_SEND_ROUTE_FRESHNESS_MS (7 days), the same window as
 * playlist discovery's ROUTE_PROOF_MAX_AGE_MS. A stamp exactly that old is
 * still fresh; one millisecond older is stale.
 *
 * Fit is explicit lane membership in the current owner-approved Song DNA.
 * An empty approved_lanes list is not a pass (stricter than decideLaneFit,
 * matching agh_record_can_approve). Identity is explicit only when
 * research_context.identity_resolved is boolean true and the row is not
 * route-only. Free terms mean submission_cost === "free". Anything else needs
 * a recorded owner override:
 *   { by: "fendi", at: <iso time>, reason: <non-empty> }
 * on the handoff packet or the target research_context, as owner_terms_override.
 *
 * This module only reads. It does not approve, send, or update rows.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { loadBlockedOperatorIndex, matchBlockedOperator } from "./blocked-operator.ts";
import { decideLaneFit } from "./song-fit.ts";
import { assessSubmissionRoute } from "./submission-route.ts";

/** Verified route proof older than this is not sendable. */
export const PRE_SEND_ROUTE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export const PRE_SEND_BLOCKERS = [
  "dna_missing",
  "dna_not_approved",
  "dna_not_owner_approved",
  "dna_not_current",
  "dna_track_mismatch",
  "dna_lookup_failed",
  "fit_not_explicit",
  "fit_lane_excluded",
  "identity_unresolved",
  "route_unverified",
  "route_verification_missing",
  "route_stale",
  "route_evidence_missing",
  "route_evidence_stale",
  "route_held",
  "terms_unknown",
  "terms_not_free",
  "terms_paid",
  "terms_override_invalid",
  "target_missing",
  "target_inactive",
  "target_activity_unknown",
  "target_blocked",
  "target_lookup_failed",
  "blocked_operator",
  "blocked_domain",
  "operator_clearance_unknown",
  "blocklist_unknown",
  "clearance_unknown",
  "clearance_identity_required",
  "clearance_inactive_target",
  "clearance_paid_curator",
  "clearance_blocked_domain",
  "clearance_suppressed_curator",
  "clearance_cooldown_conflict",
  "clearance_duplicate",
  "clearance_blocked",
  "record_missing",
  "record_ambiguous",
  "record_lookup_failed",
  "record_channel_unknown",
  "record_channel_mismatch",
  "record_not_approved_for_send",
  "record_approval_unnamed",
  "record_held",
  "record_target_mismatch",
  "record_track_mismatch",
  "batch_missing",
  "batch_lookup_failed",
  "batch_not_approved",
  "batch_approval_unnamed",
] as const;

export type PreSendBlocker = typeof PRE_SEND_BLOCKERS[number];

export type PreSendChannel = "email" | "instagram_dm" | "web_form";

export type PreSendCopy = {
  body: string;
  subject: string | null;
  recipient: string | null;
};

export type PreSendDecision = {
  sendable: boolean;
  blockers: PreSendBlocker[];
  /** Pitch copy. Null whenever sendable is false. */
  dispatch: PreSendCopy | null;
};

type Row = Record<string, unknown>;

export type ClearanceResult = { ok?: boolean; code?: string } | null;

export type PreSendInput = {
  channel: PreSendChannel;
  now: number;
  copy: PreSendCopy;
  record: Row | null;
  recordStatus: "ok" | "missing" | "ambiguous" | "lookup_failed";
  batch: Row | null;
  batchStatus: "ok" | "missing" | "lookup_failed";
  track: Row | null;
  dna: Row | null;
  dnaStatus: "ok" | "missing" | "lookup_failed";
  /** Song DNA id stamped on the draft, when the draft names one. */
  draftDnaId: string | null;
  target: Row | null;
  targetStatus: "ok" | "missing" | "lookup_failed";
  /** Playlist the send would actually use. */
  sendPlaylistId: string;
  /** Track the send would actually use. */
  sendTrackId: string;
  clearance: ClearanceResult;
  operator: "clear" | "blocked" | "unknown";
  blocklist: "clear" | "blocked" | "unknown" | "not_applicable";
};

const CLEARANCE_CODES: Record<string, PreSendBlocker> = {
  identity_required: "clearance_identity_required",
  inactive_target: "clearance_inactive_target",
  paid_curator: "clearance_paid_curator",
  blocked_domain: "clearance_blocked_domain",
  suppressed_curator: "clearance_suppressed_curator",
  cooldown_conflict: "clearance_cooldown_conflict",
  duplicate: "clearance_duplicate",
  duplicate_contact: "clearance_duplicate",
};

const VERIFIED = new Set(["auto_verified", "manually_verified"]);
const BLOCKED_PITCH = new Set(["blocked", "do_not_contact", "suppressed", "pay_to_play"]);
const BLOCKED_VERIFICATION = new Set(["blocked", "invalid", "bounced", "spam_flagged"]);

const RECORD_COLUMNS =
  "id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, approved_by, packet, outreach_draft_id";

const TARGET_COLUMNS =
  "playlist_id, playlist_name, is_active, pitch_status, verification_status, path_verified, lane, submission_cost, last_verified_at, ig_verified_at, form_verified_at, ig_curator_account, curator_instagram, ig_source_evidence, form_url, submission_url, form_source_evidence, curator_email, curator_name, curator_website, operator_group_id, research_context, contact_method, submission_method";

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function objectOf(v: unknown): Row | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
}

function finish(blockers: PreSendBlocker[], copy: PreSendCopy): PreSendDecision {
  const unique = [...new Set(blockers)];
  if (unique.length) return { sendable: false, blockers: unique, dispatch: null };
  return {
    sendable: true,
    blockers: [],
    dispatch: { body: copy.body, subject: copy.subject, recipient: copy.recipient },
  };
}

function stampState(raw: unknown, now: number): "missing" | "stale" | "fresh" {
  const text = str(raw);
  if (!text) return "missing";
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return "missing";
  if (now - parsed > PRE_SEND_ROUTE_FRESHNESS_MS) return "stale";
  return "fresh";
}

function evidenceStamp(target: Row, channel: PreSendChannel): unknown {
  if (channel === "instagram_dm") return target.ig_verified_at;
  if (channel === "web_form") return target.form_verified_at;
  return null;
}

/** Owner override is a recorded Fendi decision, not an inferred flag. */
export function ownerTermsOverrideValid(value: unknown): boolean {
  const row = objectOf(value);
  if (!row) return false;
  const by = str(row.by).toLowerCase();
  const reason = str(row.reason);
  const at = Date.parse(str(row.at));
  return by === "fendi" && reason.length > 0 && Number.isFinite(at);
}

function lanesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function overrideCandidates(record: Row | null, target: Row | null): unknown[] {
  const packet = objectOf(record?.packet) ?? {};
  const research = objectOf(target?.research_context) ?? {};
  return [packet.owner_terms_override, research.owner_terms_override].filter((value) => objectOf(value) != null);
}

function identityExplicit(target: Row): boolean {
  if (str(target.playlist_id).startsWith("route-")) return false;
  const research = objectOf(target.research_context);
  if (!research) return false;
  if (research.identity_resolved !== true) return false;
  if (str(research.identity_kind).toLowerCase() === "route_only") return false;
  return true;
}

function currentOwnerDna(track: Row | null, dna: Row | null): boolean {
  if (!track || !dna) return false;
  return str(dna.id) === str(track.approved_song_dna_version_id) &&
    str(dna.approval_state) === "approved" &&
    !!str(dna.approved_by) &&
    str(dna.track_id) === str(track.id);
}

/**
 * Pure decision. Callers load rows; this function does not touch the database.
 * `dispatch` is omitted (null) unless every blocker is clear.
 */
export function evaluatePreSendGate(input: PreSendInput): PreSendDecision {
  const blockers: PreSendBlocker[] = [];
  const channel = input.channel;

  if (input.recordStatus === "lookup_failed") blockers.push("record_lookup_failed");
  else if (input.recordStatus === "ambiguous") blockers.push("record_ambiguous");
  else if (input.recordStatus === "missing" || !input.record) blockers.push("record_missing");
  else {
    const record = input.record;
    const recordChannel = str(record.submission_channel).toLowerCase();
    if (!recordChannel) blockers.push("record_channel_unknown");
    else if (recordChannel !== channel) blockers.push("record_channel_mismatch");
    if (str(record.queue_state) !== "APPROVED_FOR_SEND") blockers.push("record_not_approved_for_send");
    if (!str(record.approved_by)) blockers.push("record_approval_unnamed");
    const packet = objectOf(record.packet) ?? {};
    if (packet.route_hold != null) blockers.push("route_held");
    if (packet.review_defer != null) blockers.push("record_held");
    if (str(record.playlist_target_id) && input.sendPlaylistId && str(record.playlist_target_id) !== input.sendPlaylistId) {
      blockers.push("record_target_mismatch");
    }
    if (str(record.track_id) && input.sendTrackId && str(record.track_id) !== input.sendTrackId) {
      blockers.push("record_track_mismatch");
    }
  }

  if (input.batchStatus === "lookup_failed") blockers.push("batch_lookup_failed");
  else if (input.batchStatus === "missing" || !input.batch) blockers.push("batch_missing");
  else {
    if (str(input.batch.queue_state) !== "APPROVED_FOR_SEND") blockers.push("batch_not_approved");
    if (!str(input.batch.approved_by)) blockers.push("batch_approval_unnamed");
  }

  const pointer = str(input.track?.approved_song_dna_version_id);
  if (input.dnaStatus === "lookup_failed") blockers.push("dna_lookup_failed");
  else if (!input.track || !pointer || !input.dna) blockers.push("dna_missing");
  else {
    if (str(input.dna.id) !== pointer) blockers.push("dna_not_current");
    if (str(input.dna.track_id) !== str(input.track.id)) blockers.push("dna_track_mismatch");
    if (str(input.dna.approval_state) !== "approved") blockers.push("dna_not_approved");
    else if (!str(input.dna.approved_by)) blockers.push("dna_not_owner_approved");
    const recordDna = input.record ? str(input.record.song_dna_version_id) : "";
    if (input.record && recordDna !== pointer) blockers.push("dna_not_current");
    if (str(input.draftDnaId) && str(input.draftDnaId) !== pointer) blockers.push("dna_not_current");
  }

  if (!currentOwnerDna(input.track, input.dnaStatus === "lookup_failed" ? null : input.dna)) {
    blockers.push("fit_not_explicit");
  } else {
    const fit = decideLaneFit(
      {
        id: str(input.dna?.id),
        primary_genre: str(input.dna?.primary_genre) || null,
        approved_lanes: lanesOf(input.dna?.approved_lanes),
        excluded_lanes: lanesOf(input.dna?.excluded_lanes),
      },
      input.target?.lane,
    );
    if (fit.code === "lane_excluded") blockers.push("fit_lane_excluded");
    else if (fit.code !== "lane_approved") blockers.push("fit_not_explicit");
  }

  if (input.targetStatus === "lookup_failed") blockers.push("target_lookup_failed");
  else if (input.targetStatus === "missing" || !input.target) blockers.push("target_missing");
  else {
    const target = input.target;
    if (!identityExplicit(target)) blockers.push("identity_unresolved");

    if (target.is_active === true) {
      /* active */
    } else if (target.is_active === false) blockers.push("target_inactive");
    else blockers.push("target_activity_unknown");

    const status = str(target.verification_status).toLowerCase();
    const flagRequired = channel !== "email";
    const statusVerified = VERIFIED.has(status);
    const routeAssessed = statusVerified && (!flagRequired || target.path_verified === true)
      ? assessSubmissionRoute(target, channel)
      : null;
    if (!statusVerified || (flagRequired && target.path_verified !== true) || (routeAssessed && !routeAssessed.ok)) {
      blockers.push("route_unverified");
    }

    const verified = stampState(target.last_verified_at, input.now);
    if (verified === "missing") blockers.push("route_verification_missing");
    else if (verified === "stale") blockers.push("route_stale");

    if (channel !== "email") {
      const evidence = stampState(evidenceStamp(target, channel), input.now);
      if (evidence === "missing") blockers.push("route_evidence_missing");
      else if (evidence === "stale") blockers.push("route_evidence_stale");
    }

    const cost = str(target.submission_cost).toLowerCase();
    const overrides = overrideCandidates(input.record, target);
    const overrideOk = overrides.some((v) => ownerTermsOverrideValid(v));
    const overridePresent = overrides.length > 0;
    if (cost !== "free") {
      if (overridePresent && !overrideOk) blockers.push("terms_override_invalid");
      if (!overrideOk) {
        if (cost === "paid") blockers.push("terms_paid");
        else if (cost === "tip_appreciated") blockers.push("terms_not_free");
        else blockers.push("terms_unknown");
      }
    }

    if (BLOCKED_PITCH.has(str(target.pitch_status).toLowerCase()) || BLOCKED_VERIFICATION.has(status)) {
      blockers.push("target_blocked");
    }
  }

  if (input.operator === "unknown") blockers.push("operator_clearance_unknown");
  else if (input.operator === "blocked") blockers.push("blocked_operator");

  if (input.blocklist === "unknown") blockers.push("blocklist_unknown");
  else if (input.blocklist === "blocked") blockers.push("blocked_domain");

  if (!input.clearance) blockers.push("clearance_unknown");
  else {
    const code = str(input.clearance.code).toLowerCase();
    if (!(input.clearance.ok === true && code === "eligible")) {
      blockers.push(CLEARANCE_CODES[code] ?? "clearance_blocked");
    }
  }

  return finish(blockers, input.copy);
}

type QueryError = { message?: string } | null;

function failed(error: QueryError): boolean {
  return !!error;
}

async function findLinkedRecord(
  sb: SupabaseClient,
  draft: Row,
): Promise<{ record: Row | null; status: PreSendInput["recordStatus"] }> {
  const pointed = str(objectOf(draft.metadata)?.handoff_record_id);
  if (pointed) {
    const { data, error } = await sb.from("agh_handoff_records").select(RECORD_COLUMNS).eq("id", pointed).maybeSingle();
    if (failed(error)) return { record: null, status: "lookup_failed" };
    if (data) return { record: data as Row, status: "ok" };
  }
  const draftId = str(draft.id);
  if (!draftId) return { record: null, status: "missing" };
  const { data, error } = await sb.from("agh_handoff_records").select(RECORD_COLUMNS).eq("outreach_draft_id", draftId);
  if (failed(error)) return { record: null, status: "lookup_failed" };
  const rows = ((data ?? []) as Row[]).filter((row) => {
    const playlistOk = !str(draft.playlist_id) || str(row.playlist_target_id) === str(draft.playlist_id);
    const trackOk = !str(draft.track_id) || str(row.track_id) === str(draft.track_id);
    return playlistOk && trackOk;
  });
  if (rows.length === 1) return { record: rows[0], status: "ok" };
  if (rows.length > 1) return { record: null, status: "ambiguous" };
  return { record: null, status: "missing" };
}

async function loadBatch(
  sb: SupabaseClient,
  batchId: string,
): Promise<{ batch: Row | null; status: PreSendInput["batchStatus"] }> {
  if (!batchId) return { batch: null, status: "missing" };
  const { data, error } = await sb.from("agh_handoff_batches").select("id, queue_state, approved_by").eq("id", batchId).maybeSingle();
  if (failed(error)) return { batch: null, status: "lookup_failed" };
  if (!data) return { batch: null, status: "missing" };
  return { batch: data as Row, status: "ok" };
}

async function loadTrack(
  sb: SupabaseClient,
  trackId: string,
): Promise<{ track: Row | null; failed: boolean }> {
  if (!trackId) return { track: null, failed: false };
  const { data, error } = await sb.from("tracks").select("id, name, approved_song_dna_version_id").eq("id", trackId).maybeSingle();
  if (failed(error)) return { track: null, failed: true };
  return { track: (data as Row) ?? null, failed: false };
}

async function loadDna(
  sb: SupabaseClient,
  dnaId: string,
): Promise<{ dna: Row | null; status: PreSendInput["dnaStatus"] }> {
  if (!dnaId) return { dna: null, status: "missing" };
  const { data, error } = await sb.from("song_dna_versions")
    .select("id, track_id, approval_state, approved_by, approved_lanes, excluded_lanes, primary_genre")
    .eq("id", dnaId)
    .maybeSingle();
  if (failed(error)) return { dna: null, status: "lookup_failed" };
  if (!data) return { dna: null, status: "missing" };
  return { dna: data as Row, status: "ok" };
}

async function loadTarget(
  sb: SupabaseClient,
  playlistId: string,
): Promise<{ target: Row | null; status: PreSendInput["targetStatus"] }> {
  if (!playlistId) return { target: null, status: "missing" };
  const { data, error } = await sb.from("playlist_targets").select(TARGET_COLUMNS).eq("playlist_id", playlistId).maybeSingle();
  if (failed(error)) return { target: null, status: "lookup_failed" };
  if (!data) return { target: null, status: "missing" };
  return { target: data as Row, status: "ok" };
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  return email.slice(at + 1).toLowerCase();
}

function domainBlocked(email: string, domains: string[]): boolean {
  const host = emailDomain(email);
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function loadDomains(sb: SupabaseClient): Promise<string[] | null> {
  const { data, error } = await sb.from("domain_blocklist").select("domain");
  if (failed(error)) return null;
  return ((data ?? []) as Row[]).map((row) => str(row.domain).toLowerCase()).filter(Boolean);
}

async function loadClearance(
  sb: SupabaseClient,
  playlistId: string,
  trackId: string,
  channel: string,
): Promise<ClearanceResult> {
  if (!playlistId || !trackId) return null;
  const { data, error } = await sb.rpc("agh_contact_policy", {
    p_target: playlistId,
    p_track: trackId,
    p_channel: channel,
  });
  if (failed(error) || data == null) return null;
  const row = Array.isArray(data) ? data[0] : data;
  const object = objectOf(row);
  if (!object) return null;
  return { ok: object.ok === true, code: str(object.code) || undefined };
}

function operatorOf(
  index: Awaited<ReturnType<typeof loadBlockedOperatorIndex>>["index"] | null,
  failedLoad: boolean,
  target: Row | null,
): PreSendInput["operator"] {
  if (failedLoad || !index) return "unknown";
  if (!target) return "clear";
  const hit = matchBlockedOperator(index, {
    playlistId: str(target.playlist_id) || null,
    playlistName: str(target.playlist_name) || null,
    curatorEmail: str(target.curator_email) || null,
    curatorName: str(target.curator_name) || null,
    formUrl: str(target.form_url) || null,
    submissionUrl: str(target.submission_url) || null,
    website: str(target.curator_website) || null,
    igAccount: str(target.ig_curator_account || target.curator_instagram) || null,
  });
  return hit ? "blocked" : "clear";
}

function blocklistOf(domains: string[] | null, target: Row | null): PreSendInput["blocklist"] {
  const email = str(target?.curator_email).toLowerCase();
  if (!email) return "not_applicable";
  if (!domains) return "unknown";
  return domainBlocked(email, domains) ? "blocked" : "clear";
}

function copyFrom(draft: Row | null, explicit?: PreSendCopy): PreSendCopy {
  if (explicit) return { body: explicit.body, subject: explicit.subject, recipient: explicit.recipient };
  return {
    body: str(draft?.body),
    subject: str(draft?.subject) || null,
    recipient: str(draft?.recipient) || null,
  };
}

/**
 * Email dispatch gate. Resolves the linked handoff, current Song DNA, batch
 * approval, route, terms, operator index, domain blocklist, and canonical
 * contact policy, then applies evaluatePreSendGate.
 * test_mode and cap overrides are not arguments — they cannot waive this.
 */
export async function gateEmailDispatch(
  sb: SupabaseClient,
  args: { draft: Row; target?: Row | null; now?: number },
): Promise<PreSendDecision> {
  const now = args.now ?? Date.now();
  const draft = args.draft;
  const copy = copyFrom(draft);
  const linked = await findLinkedRecord(sb, draft);
  const sendTrackId = str(draft.track_id) || str(linked.record?.track_id);
  const sendPlaylistId = str(draft.playlist_id) || str(linked.record?.playlist_target_id) || str(args.target?.playlist_id);
  const [batch, trackLoaded, targetLoaded, operatorLoaded, domains] = await Promise.all([
    loadBatch(sb, str(linked.record?.batch_id)),
    loadTrack(sb, sendTrackId),
    args.target ? Promise.resolve({ target: args.target, status: "ok" as const }) : loadTarget(sb, sendPlaylistId),
    loadBlockedOperatorIndex(sb),
    loadDomains(sb),
  ]);
  const dna = trackLoaded.failed
    ? { dna: null, status: "lookup_failed" as const }
    : await loadDna(sb, str(trackLoaded.track?.approved_song_dna_version_id));
  const clearance = await loadClearance(sb, sendPlaylistId, sendTrackId, "email");
  return evaluatePreSendGate({
    channel: "email",
    now,
    copy,
    record: linked.record,
    recordStatus: linked.status,
    batch: batch.batch,
    batchStatus: batch.status,
    track: trackLoaded.track,
    dna: dna.dna,
    dnaStatus: dna.status,
    draftDnaId: str(draft.song_dna_version_id) || null,
    target: targetLoaded.target,
    targetStatus: targetLoaded.status,
    sendPlaylistId,
    sendTrackId,
    clearance,
    operator: operatorOf(operatorLoaded.index, !!operatorLoaded.error, targetLoaded.target),
    blocklist: blocklistOf(domains, targetLoaded.target),
  });
}

export type QueuedSendRow = {
  record: Row;
  draft: Row | null;
  target: Row | null;
  track: Row | null;
};

/**
 * One gate decision per handoff already loaded by a queue reader.
 * Shared lookups (operators, blocklist, batches, DNA, contact policy) run
 * once per call. A failed lookup becomes a blocker on the affected rows
 * and never a sendable body.
 */
export async function decideHandoffSends(
  sb: SupabaseClient,
  args: { channel: PreSendChannel; rows: QueuedSendRow[]; now?: number },
): Promise<Map<string, PreSendDecision>> {
  const now = args.now ?? Date.now();
  const out = new Map<string, PreSendDecision>();
  const records = args.rows.map((row) => row.record);
  const batchIds = [...new Set(records.map((row) => str(row.batch_id)).filter(Boolean))];
  const dnaIds = [...new Set(args.rows.map((row) => str(row.track?.approved_song_dna_version_id)).filter(Boolean))];

  const [batches, dnaRows, operatorLoaded, domains] = await Promise.all([
    loadByIds(sb, "agh_handoff_batches", "id, queue_state, approved_by", batchIds),
    loadByIds(sb, "song_dna_versions", "id, track_id, approval_state, approved_by, approved_lanes, excluded_lanes, primary_genre", dnaIds),
    loadBlockedOperatorIndex(sb),
    loadDomains(sb),
  ]);

  const clearances = new Map<string, ClearanceResult>();
  await Promise.all(args.rows.map(async (row) => {
    const id = str(row.record.id);
    clearances.set(id, await loadClearance(
      sb,
      str(row.record.playlist_target_id) || str(row.target?.playlist_id),
      str(row.record.track_id) || str(row.track?.id),
      args.channel,
    ));
  }));

  for (const row of args.rows) {
    const id = str(row.record.id);
    const batchId = str(row.record.batch_id);
    const pointer = str(row.track?.approved_song_dna_version_id);
    const batchHit = batchId ? batches.rows.get(batchId) : undefined;
    const dnaHit = pointer ? dnaRows.rows.get(pointer) : undefined;
    out.set(id, evaluatePreSendGate({
      channel: args.channel,
      now,
      copy: copyFrom(row.draft),
      record: row.record,
      recordStatus: "ok",
      batch: batchHit ?? null,
      batchStatus: !batchId ? "missing" : batches.error ? "lookup_failed" : batchHit ? "ok" : "missing",
      track: row.track,
      dna: dnaHit ?? null,
      dnaStatus: !pointer ? "missing" : dnaRows.error ? "lookup_failed" : dnaHit ? "ok" : "missing",
      draftDnaId: str(row.draft?.song_dna_version_id) || null,
      target: row.target,
      targetStatus: row.target ? "ok" : "missing",
      sendPlaylistId: str(row.record.playlist_target_id) || str(row.target?.playlist_id),
      sendTrackId: str(row.record.track_id) || str(row.track?.id),
      clearance: clearances.get(id) ?? null,
      operator: operatorOf(operatorLoaded.index, !!operatorLoaded.error, row.target),
      blocklist: blocklistOf(domains, row.target),
    }));
  }
  return out;
}

async function loadByIds(
  sb: SupabaseClient,
  table: string,
  columns: string,
  ids: string[],
): Promise<{ rows: Map<string, Row>; error: boolean }> {
  const rows = new Map<string, Row>();
  if (!ids.length) return { rows, error: false };
  const { data, error } = await sb.from(table).select(columns).in("id", ids);
  if (failed(error)) return { rows, error: true };
  for (const row of (data ?? []) as Row[]) rows.set(str(row.id), row);
  return { rows, error: false };
}
