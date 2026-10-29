/**
 * Automatic Instagram curator send.
 *
 * Fendi's approval is the shared pre-send gate (record and batch already
 * APPROVED_FOR_SEND, plus every other blocker). This module does not ask
 * Fendi or Enki to confirm a row. The outreach scheduler calls
 * `dispatch_ig_curator_sends`. Approving one Instagram draft with
 * send_immediately calls the same function for that draft.
 *
 * Where the per-send confirmation used to live:
 *   - approve_draft returned needs_manual_dm and the DM body, telling Muse to
 *     copy it onto Instagram
 *   - list_ig_dm_send_queue was the pack Enki read and sent by hand
 *   - mark_manual_ig_dm_submitted was the human receipt after that send
 *   - docs/MUSE_IG_RECEIPT.md and docs/HANDOFF_IG_SEND_PATH_MUSE.md told Enki
 *     to send each sendable row
 * The 2026-10-14 duplicate batch came from that pack being handed out twice.
 *
 * Order for a row the gate marks sendable: prepare the transport (no claim if
 * Meta cannot address it), atomic claim, send, mark sent or failed. A second
 * dispatch sees the claim and does not send again.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { chicagoBusinessDate } from "./chicago-time.ts";
import { decideHandoffSends, type PreSendDecision } from "./pre-send-gate.ts";
import { graphDmPrepare, graphInstagramDmSend, type GraphDmArgs, type GraphDmResult } from "./ig-graph-dm.ts";
import { pickSendDraft } from "./ig-dm-send-queue.ts";

type Row = Record<string, unknown>;

export const IG_CURATOR_SEND_ENABLED_ENV = "IG_CURATOR_SEND_ENABLED";
export const IG_CURATOR_DAILY_CAP_ENV = "IG_CURATOR_DAILY_CAP";
export const IG_CURATOR_DEFAULT_DAILY_CAP = 10;

export type IgSendCandidate = {
  handoffRecordId: string;
  trackId: string;
  playlistId: string;
  handle: string;
  body: string;
  recipientId: string | null;
  optedOut: boolean;
  priorReceipt: boolean;
  /** Computed at send time. A queue-time flag is not accepted. */
  decision: PreSendDecision;
};

export type IgSendOutcome = {
  handoffRecordId: string;
  handle: string;
  result: "sent" | "not_sent";
  code: string;
  providerMessageId?: string;
};

export type ClaimResult =
  | { ok: true }
  | { ok: false; code: "duplicate" | "cap" | "already_receipted" | "claim_failed"; detail?: string };

export type IgClaimStore = {
  tryClaim(args: {
    claimKey: string;
    handoffRecordId: string;
    trackId: string;
    handle: string;
    dailyCap: number;
    dayStartIso: string;
  }): Promise<ClaimResult>;
  finish(args: {
    claimKey: string;
    status: "sent" | "failed";
    providerMessageId?: string | null;
    failureCode?: string | null;
  }): Promise<{ ok: boolean; error?: string }>;
};

export type IgDmTransport = {
  prepare(args: GraphDmArgs): { ok: true } | { ok: false; code: string; error: string };
  send(args: GraphDmArgs): Promise<GraphDmResult>;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

export function normalizeIgHandle(value: unknown): string {
  return str(value).replace(/^@+/, "").toLowerCase();
}

export function igClaimKey(trackId: string, handle: string): string {
  return `${trackId}:${normalizeIgHandle(handle)}`;
}

export function igCuratorSendEnabled(env: { get(name: string): string | undefined }): boolean {
  return env.get(IG_CURATOR_SEND_ENABLED_ENV) === "true";
}

export function igCuratorDailyCap(env: { get(name: string): string | undefined }): number {
  const raw = env.get(IG_CURATOR_DAILY_CAP_ENV);
  if (raw == null || raw.trim() === "") return IG_CURATOR_DEFAULT_DAILY_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return IG_CURATOR_DEFAULT_DAILY_CAP;
  return Math.floor(n);
}

/** UTC instant of America/Chicago midnight for the business day containing `now`. */
export function chicagoDayStartIso(now: number): string {
  const day = chicagoBusinessDate(new Date(now));
  let t = Date.parse(`${day}T12:00:00.000Z`);
  const step = 60 * 1000;
  while (chicagoBusinessDate(new Date(t)) !== day) t += 60 * 60 * 1000;
  while (chicagoBusinessDate(new Date(t - step)) === day) t -= step;
  return new Date(t).toISOString();
}

export function memoryClaimStore(now: number): IgClaimStore & {
  rows: Map<string, { status: string; at: number }>;
} {
  const rows = new Map<string, { status: string; at: number }>();
  return {
    rows,
    async tryClaim(args) {
      const existing = rows.get(args.claimKey);
      if (existing && (existing.status === "claimed" || existing.status === "sent" || existing.status === "failed")) {
        return { ok: false, code: "duplicate", detail: existing.status };
      }
      const dayStart = Date.parse(args.dayStartIso);
      let used = 0;
      for (const row of rows.values()) {
        if ((row.status === "claimed" || row.status === "sent") && row.at >= dayStart) used += 1;
      }
      if (used >= args.dailyCap) return { ok: false, code: "cap" };
      rows.set(args.claimKey, { status: "claimed", at: now });
      return { ok: true };
    },
    async finish(args) {
      const row = rows.get(args.claimKey);
      if (!row) return { ok: false, error: "missing claim" };
      row.status = args.status;
      return { ok: true };
    },
  };
}

export function graphDmTransport(env: { get(name: string): string | undefined }): IgDmTransport {
  const token = env.get("INSTAGRAM_MESSAGING_API_TOKEN");
  return {
    prepare(args) {
      return graphDmPrepare(args, token);
    },
    send(args) {
      if (!args.recipientId || !token) {
        return Promise.resolve({ ok: false, code: "meta_cold_dm_unsupported", error: "not prepared" });
      }
      return graphInstagramDmSend({ ...args, recipientId: args.recipientId }, { token });
    },
  };
}

/**
 * Pure send loop. The gate decision must already have been computed for this
 * attempt. Kill switch and cap run here. Claim happens only after the
 * transport says it can address the row, and always before send.
 */
export async function runIgCuratorDispatch(args: {
  enabled: boolean;
  dailyCap: number;
  now: number;
  candidates: IgSendCandidate[];
  claims: IgClaimStore;
  transport: IgDmTransport;
}): Promise<{ paused: boolean; sentCount: number; outcomes: IgSendOutcome[] }> {
  if (!args.enabled) {
    return {
      paused: true,
      sentCount: 0,
      outcomes: args.candidates.map((row) => ({
        handoffRecordId: row.handoffRecordId,
        handle: row.handle,
        result: "not_sent",
        code: "kill_switch",
      })),
    };
  }
  const dayStartIso = chicagoDayStartIso(args.now);
  const outcomes: IgSendOutcome[] = [];
  let sentCount = 0;
  for (const row of args.candidates) {
    const base = { handoffRecordId: row.handoffRecordId, handle: row.handle };
    if (!row.decision.sendable) {
      outcomes.push({ ...base, result: "not_sent", code: row.decision.blockers[0] ?? "gate_blocked" });
      continue;
    }
    if (row.optedOut) {
      outcomes.push({ ...base, result: "not_sent", code: "opted_out" });
      continue;
    }
    if (row.priorReceipt) {
      outcomes.push({ ...base, result: "not_sent", code: "already_receipted" });
      continue;
    }
    if (!row.handle || !row.trackId || !row.body.trim()) {
      outcomes.push({ ...base, result: "not_sent", code: "incomplete_row" });
      continue;
    }
    const graphArgs: GraphDmArgs = {
      handle: row.handle,
      body: row.body,
      recipientId: row.recipientId,
      handoffRecordId: row.handoffRecordId,
    };
    const ready = args.transport.prepare(graphArgs);
    if (!ready.ok) {
      outcomes.push({ ...base, result: "not_sent", code: ready.code });
      continue;
    }
    const claimKey = igClaimKey(row.trackId, row.handle);
    const claim = await args.claims.tryClaim({
      claimKey,
      handoffRecordId: row.handoffRecordId,
      trackId: row.trackId,
      handle: row.handle,
      dailyCap: args.dailyCap,
      dayStartIso,
    });
    if (!claim.ok) {
      outcomes.push({ ...base, result: "not_sent", code: claim.code });
      continue;
    }
    let sent: GraphDmResult;
    try {
      sent = await args.transport.send(graphArgs);
    } catch (error) {
      await args.claims.finish({
        claimKey,
        status: "failed",
        failureCode: "transport_threw",
      });
      outcomes.push({
        ...base,
        result: "not_sent",
        code: "transport_threw",
      });
      continue;
    }
    if (!sent.ok) {
      await args.claims.finish({ claimKey, status: "failed", failureCode: sent.code });
      outcomes.push({ ...base, result: "not_sent", code: sent.code });
      continue;
    }
    const finished = await args.claims.finish({
      claimKey,
      status: "sent",
      providerMessageId: sent.providerMessageId,
    });
    if (!finished.ok) {
      outcomes.push({ ...base, result: "not_sent", code: "claim_finish_failed" });
      continue;
    }
    sentCount += 1;
    outcomes.push({ ...base, result: "sent", code: "sent", providerMessageId: sent.providerMessageId });
  }
  return { paused: false, sentCount, outcomes };
}

function objectOf(v: unknown): Row | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Row : null;
}

function recipientIdOf(target: Row | null, roster: Row | null): string | null {
  const research = objectOf(target?.research_context) ?? {};
  const fromTarget = str(research.ig_user_id) || str(research.igsid) || str(research.recipient_id);
  if (fromTarget) return fromTarget;
  return str(roster?.ig_user_id) || null;
}

function optedOut(target: Row | null, roster: Row | null): boolean {
  const research = objectOf(target?.research_context) ?? {};
  if (research.ig_opt_out === true || research.opted_out === true) return true;
  if (roster?.do_not_contact === true) return true;
  return false;
}

export function supabaseClaimStore(sb: SupabaseClient): IgClaimStore {
  return {
    async tryClaim(args) {
      const { data, error } = await sb.rpc("agh_claim_ig_curator_send", {
        p_key: args.claimKey,
        p_handoff: args.handoffRecordId,
        p_track: args.trackId,
        p_handle: args.handle,
        p_cap: args.dailyCap,
        p_day_start: args.dayStartIso,
      });
      if (error) {
        const missing = /does not exist|PGRST202|42883|schema cache/i.test(String(error.message));
        return { ok: false, code: "claim_failed", detail: missing ? "migration_required" : error.message };
      }
      const row = objectOf(data) ?? {};
      if (row.ok === true) return { ok: true };
      const code = str(row.code);
      if (code === "duplicate" || code === "cap" || code === "already_receipted") return { ok: false, code };
      return { ok: false, code: "claim_failed", detail: code || "claim_rejected" };
    },
    async finish(args) {
      const { error } = await sb.from("agh_ig_dm_send_log").update({
        status: args.status,
        provider_message_id: args.providerMessageId ?? null,
        failure_code: args.failureCode ?? null,
        finished_at: new Date().toISOString(),
      }).eq("claim_key", args.claimKey);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    },
  };
}

async function stampSentReceipt(
  sb: SupabaseClient,
  row: IgSendCandidate,
  providerMessageId: string,
  nowIso: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: current, error: readErr } = await sb
    .from("agh_handoff_records")
    .select("id, packet, queue_state, submitted_at")
    .eq("id", row.handoffRecordId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!current) return { ok: false, error: "handoff missing" };
  if (current.submitted_at) return { ok: true };
  const packet = objectOf(current.packet) ?? {};
  const evidence = {
    result: "submitted",
    reference: providerMessageId,
    notes: "Automatic Instagram send. No separate approval.",
    submitted_at: nowIso,
  };
  const { error: stampErr } = await sb.from("agh_handoff_records").update({
    submitted_at: nowIso,
    submitted_by: "ig_curator_auto_send",
    manual_submit_channel: "instagram_dm",
    manual_submit_result: "submitted",
    packet: { ...packet, submission_evidence: evidence },
    updated_at: nowIso,
  }).eq("id", row.handoffRecordId).is("submitted_at", null);
  if (stampErr) return { ok: false, error: stampErr.message };
  const { error: closeErr } = await sb.from("agh_handoff_records").update({
    queue_state: "SENT",
    updated_at: nowIso,
  }).eq("id", row.handoffRecordId).eq("queue_state", "APPROVED_FOR_SEND");
  if (closeErr) return { ok: false, error: closeErr.message };
  return { ok: true };
}

/**
 * Load approved unsent Instagram handoffs, re-run the shared pre-send gate,
 * then claim and send. `enabled` / `dailyCap` default from the environment.
 * Pass `claims` and `transport` in tests.
 */
export async function dispatchIgCuratorSends(
  sb: SupabaseClient,
  opts: {
    now?: number;
    enabled?: boolean;
    dailyCap?: number;
    handoffRecordId?: string | null;
    playlistId?: string | null;
    trackId?: string | null;
    claims?: IgClaimStore;
    transport?: IgDmTransport;
    env?: { get(name: string): string | undefined };
  } = {},
): Promise<{
  status: number;
  paused: boolean;
  code: string | null;
  sent_count: number;
  outcomes: IgSendOutcome[];
  error?: string;
}> {
  const env = opts.env ?? Deno.env;
  const now = opts.now ?? Date.now();
  const enabled = opts.enabled ?? igCuratorSendEnabled(env);
  const dailyCap = opts.dailyCap ?? igCuratorDailyCap(env);
  const claims = opts.claims ?? supabaseClaimStore(sb);
  const transport = opts.transport ?? graphDmTransport(env);

  const { data, error } = await sb
    .from("agh_handoff_records")
    .select("id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, approved_by, outreach_draft_id, packet, submitted_at, updated_at")
    .eq("submission_channel", "instagram_dm")
    .eq("queue_state", "APPROVED_FOR_SEND")
    .is("submitted_at", null)
    .order("updated_at", { ascending: true })
    .limit(100);
  if (error) return { status: 500, paused: false, code: "db_error", sent_count: 0, outcomes: [], error: error.message };
  let records = (data ?? []) as Row[];
  if (opts.handoffRecordId) records = records.filter((row) => str(row.id) === opts.handoffRecordId);
  if (opts.playlistId) records = records.filter((row) => str(row.playlist_target_id) === opts.playlistId);
  if (opts.trackId) records = records.filter((row) => str(row.track_id) === opts.trackId);
  if (!records.length) {
    return { status: 200, paused: !enabled, code: enabled ? null : "kill_switch", sent_count: 0, outcomes: [] };
  }

  const trackIds = [...new Set(records.map((r) => str(r.track_id)).filter(Boolean))];
  const playlistIds = [...new Set(records.map((r) => str(r.playlist_target_id)).filter(Boolean))];
  const [tracksRes, targetsRes, draftsRes] = await Promise.all([
    sb.from("tracks").select("id, name, approved_song_dna_version_id").in("id", trackIds),
    sb.from("playlist_targets").select("playlist_id, playlist_name, ig_curator_account, curator_instagram, curator_name, curator_email, curator_website, form_url, submission_url, operator_group_id, is_active, pitch_status, verification_status, path_verified, lane, submission_cost, last_verified_at, ig_verified_at, form_verified_at, ig_source_evidence, form_source_evidence, research_context, contact_method, submission_method").in("playlist_id", playlistIds),
    sb.from("outreach_drafts").select("id, track_id, playlist_id, channel, status, body, recipient, generated_by, approved_by, approved_at, generated_at, created_at, metadata, song_dna_version_id, subject").eq("channel", "instagram_dm").in("playlist_id", playlistIds),
  ]);
  if (tracksRes.error || targetsRes.error || draftsRes.error) {
    return {
      status: 500,
      paused: false,
      code: "db_error",
      sent_count: 0,
      outcomes: [],
      error: tracksRes.error?.message || targetsRes.error?.message || draftsRes.error?.message,
    };
  }
  const tracks = new Map<string, Row>();
  for (const row of (tracksRes.data ?? []) as Row[]) tracks.set(str(row.id), row);
  const targets = new Map<string, Row>();
  for (const row of (targetsRes.data ?? []) as Row[]) targets.set(str(row.playlist_id), row);
  const drafts = (draftsRes.data ?? []) as Row[];

  const handles = [...new Set(records.map((record) => {
    const target = targets.get(str(record.playlist_target_id)) ?? null;
    const draft = pickSendDraft(record, drafts);
    return normalizeIgHandle(draft?.recipient || target?.ig_curator_account || target?.curator_instagram);
  }).filter(Boolean))];
  const roster = new Map<string, Row>();
  let rosterUnreadable = false;
  if (handles.length) {
    const rosterRes = await sb.from("instagram_fan_roster").select("ig_handle, ig_user_id, do_not_contact").in("ig_handle", handles);
    if (rosterRes.error) rosterUnreadable = true;
    else for (const row of (rosterRes.data ?? []) as Row[]) roster.set(normalizeIgHandle(row.ig_handle), row);
  }

  const decisions = await decideHandoffSends(sb, {
    channel: "instagram_dm",
    now,
    rows: records.map((record) => ({
      record,
      draft: pickSendDraft(record, drafts),
      target: targets.get(str(record.playlist_target_id)) ?? null,
      track: tracks.get(str(record.track_id)) ?? null,
    })),
  });

  const prior = await sb.from("agh_ig_dm_send_log").select("claim_key, status").in(
    "claim_key",
    records.map((record) => igClaimKey(str(record.track_id), normalizeIgHandle(
      pickSendDraft(record, drafts)?.recipient ||
        targets.get(str(record.playlist_target_id))?.ig_curator_account ||
        targets.get(str(record.playlist_target_id))?.curator_instagram,
    ))),
  );
  const priorKeys = new Set<string>();
  if (!prior.error) {
    for (const row of (prior.data ?? []) as Row[]) {
      if (["claimed", "sent", "failed"].includes(str(row.status))) priorKeys.add(str(row.claim_key));
    }
  }

  const candidates: IgSendCandidate[] = records.map((record) => {
    const target = targets.get(str(record.playlist_target_id)) ?? null;
    const draft = pickSendDraft(record, drafts);
    const handle = normalizeIgHandle(draft?.recipient || target?.ig_curator_account || target?.curator_instagram);
    const trackId = str(record.track_id);
    const fan = roster.get(handle) ?? null;
    const decision = decisions.get(str(record.id)) ?? {
      sendable: false,
      blockers: ["record_missing" as const],
      warnings: [],
      dispatch: null,
    };
    return {
      handoffRecordId: str(record.id),
      trackId,
      playlistId: str(record.playlist_target_id),
      handle,
      body: decision.dispatch?.body || str(draft?.body),
      recipientId: recipientIdOf(target, fan),
      optedOut: rosterUnreadable || optedOut(target, fan),
      priorReceipt: priorKeys.has(igClaimKey(trackId, handle)),
      decision,
    };
  });

  const ran = await runIgCuratorDispatch({
    enabled,
    dailyCap,
    now,
    candidates,
    claims,
    transport,
  });
  if (!ran.paused) {
    const nowIso = new Date(now).toISOString();
    for (const outcome of ran.outcomes) {
      if (outcome.result !== "sent") continue;
      const row = candidates.find((item) => item.handoffRecordId === outcome.handoffRecordId);
      if (!row || !outcome.providerMessageId) continue;
      await stampSentReceipt(sb, row, outcome.providerMessageId, nowIso);
    }
  }
  const migrationMissing = ran.outcomes.some((row) => row.code === "claim_failed");
  return {
    status: migrationMissing ? 503 : 200,
    paused: ran.paused,
    code: ran.paused ? "kill_switch" : migrationMissing ? "migration_required" : null,
    sent_count: ran.sentCount,
    outcomes: ran.outcomes,
  };
}
