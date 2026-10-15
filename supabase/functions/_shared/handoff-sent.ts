/**
 * After a real email send, move the linked handoff record to SENT.
 * Approve-and-send does not wait for the handoff to be APPROVED_FOR_SEND, so a
 * linked row still in review or already imported moves too.
 * Does not insert pitch_log, receipts, or submitted_at, so quota is unchanged.
 * Does not send anything. A Soundplate submission method, a Soundplate URL on
 * the handoff packet, and generated_by='fendi' drafts stay put. A Soundplate
 * form URL stored only on the playlist target does not block an email send.
 * A bounce is recorded on the packet and is not labeled SENT.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { isFrozenDiscoveryRouteUrl } from "./playlist-funnel.ts";

export type HandoffSentResult = { updated_ids: string[]; error?: string };

/** States a successful Resend accept may move to SENT. */
export const EMAIL_HANDOFF_SENT_FROM_STATES = [
  "AWAITING_GROK_REVIEW",
  "GROK_REVIEWED",
  "APPROVED_FOR_SEND",
  "AWAITING_AGH_IMPORT",
  "IMPORTED_TO_AGH",
] as const;

const SENT_FROM = new Set<string>(EMAIL_HANDOFF_SENT_FROM_STATES);

function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function asPacket(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

function pitchBounced(row: Record<string, unknown>): boolean {
  return s(row.status).toLowerCase() === "bounced" || s(row.placement_status).toLowerCase() === "bounced";
}

async function loadFendiDraftIds(
  sb: SupabaseClient,
  ids: string[],
): Promise<{ ids: Set<string>; error?: string }> {
  const unique = [...new Set(ids.map(s).filter(Boolean))];
  if (!unique.length) return { ids: new Set() };
  const { data, error } = await sb.from("outreach_drafts").select("id, generated_by").in("id", unique);
  if (error) return { ids: new Set(), error: error.message };
  const fendi = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    if (s(row.generated_by) === "fendi") fendi.add(String(row.id));
  }
  return { ids: fendi };
}

async function loadTargets(
  sb: SupabaseClient,
  ids: string[],
): Promise<{ byId: Map<string, Record<string, unknown>>; error?: string }> {
  const unique = [...new Set(ids.map(s).filter(Boolean))];
  const byId = new Map<string, Record<string, unknown>>();
  if (!unique.length) return { byId };
  const { data, error } = await sb.from("playlist_targets")
    .select("playlist_id, form_url, submission_url, curator_website, submission_method")
    .in("playlist_id", unique);
  if (error) return { byId, error: error.message };
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    byId.set(String(row.playlist_id), row);
  }
  return { byId };
}

/**
 * An email handoff is a Soundplate route when the target or the packet says
 * submission_method soundplate, or when the packet itself carries a Soundplate
 * form. A form URL that only lives on playlist_targets is contact metadata for
 * a different route and must not block a Resend accept.
 */
function emailRouteIsSoundplate(
  row: Record<string, unknown>,
  target: Record<string, unknown> | null,
): boolean {
  const packet = asPacket(row.packet);
  const methodSource = target && target.submission_method != null
    ? target.submission_method
    : packet.submission_method;
  if (s(methodSource).toLowerCase() === "soundplate") return true;
  return isFrozenDiscoveryRouteUrl(packet.form_url) || isFrozenDiscoveryRouteUrl(packet.submission_url);
}

function skipRow(
  row: Record<string, unknown>,
  fendi: Set<string>,
  targets: Map<string, Record<string, unknown>>,
): boolean {
  const channel = s(row.submission_channel) || "email";
  if (channel !== "email") return true;
  if (fendi.has(s(row.outreach_draft_id))) return true;
  const target = targets.get(s(row.playlist_target_id)) ?? null;
  return emailRouteIsSoundplate(row, target);
}

/**
 * Mark linked email handoffs that belong to this accept. Web forms, Instagram
 * DMs, Soundplate submission routes, and fendi drafts are left alone. A missing
 * provider id does not move anything. Playlist+track matching stays limited to APPROVED_FOR_SEND
 * so a send cannot close a different review row on the same playlist.
 */
export async function markLinkedHandoffEmailSent(
  sb: SupabaseClient,
  opts: {
    draftId: string | null;
    playlistId: string | null;
    trackId: string | null;
    pitchLogId: string | null;
    resendMessageId: string | null;
    sentAt: string;
  },
): Promise<HandoffSentResult> {
  const resendMessageId = s(opts.resendMessageId);
  const pitchLogId = s(opts.pitchLogId);
  if (!resendMessageId || !pitchLogId) return { updated_ids: [] };

  const draftId = s(opts.draftId);
  const playlistId = s(opts.playlistId);
  const trackId = s(opts.trackId);
  const found = new Map<string, Record<string, unknown>>();
  const cols = "id, queue_state, submission_channel, packet, outreach_draft_id, playlist_target_id";

  if (draftId) {
    const { data, error } = await sb.from("agh_handoff_records").select(cols).eq("outreach_draft_id", draftId);
    if (error) return { updated_ids: [], error: error.message };
    for (const row of (data ?? []) as Record<string, unknown>[]) found.set(String(row.id), row);
  }
  if (playlistId && trackId) {
    const { data, error } = await sb.from("agh_handoff_records").select(cols)
      .eq("playlist_target_id", playlistId)
      .eq("track_id", trackId)
      .eq("queue_state", "APPROVED_FOR_SEND");
    if (error) return { updated_ids: [...found.keys()], error: error.message };
    for (const row of (data ?? []) as Record<string, unknown>[]) found.set(String(row.id), row);
  }

  const draftIds = [draftId, ...[...found.values()].map((row) => s(row.outreach_draft_id))];
  const fendi = await loadFendiDraftIds(sb, draftIds);
  if (fendi.error) return { updated_ids: [], error: fendi.error };
  if (draftId && fendi.ids.has(draftId)) return { updated_ids: [] };

  const targets = await loadTargets(sb, [...found.values()].map((row) => s(row.playlist_target_id)));
  if (targets.error) return { updated_ids: [], error: targets.error };

  const updated: string[] = [];
  for (const [id, row] of found) {
    if (!SENT_FROM.has(s(row.queue_state))) continue;
    if (skipRow(row, fendi.ids, targets.byId)) continue;
    const packet = asPacket(row.packet);
    packet.email_dispatch = {
      pitch_log_id: pitchLogId,
      resend_message_id: resendMessageId,
      sent_at: opts.sentAt,
      channel: "email",
      outcome: "sent",
      prior_queue_state: s(row.queue_state),
    };
    const { data, error } = await sb.from("agh_handoff_records")
      .update({
        queue_state: "SENT",
        packet,
        updated_at: opts.sentAt,
      })
      .eq("id", id)
      .eq("queue_state", s(row.queue_state))
      .select("id");
    if (error) return { updated_ids: updated, error: error.message };
    if ((data ?? []).length) updated.push(id);
  }
  return { updated_ids: updated };
}

/**
 * A Resend bounce is not a delivery. Stamp the linked email handoff and, when
 * this send had moved it to SENT, put the previous queue state back.
 */
export async function markLinkedHandoffEmailBounced(
  sb: SupabaseClient,
  opts: {
    resendMessageId: string | null;
    pitchLogId?: string | null;
    bouncedAt: string;
  },
): Promise<HandoffSentResult> {
  const resendMessageId = s(opts.resendMessageId);
  const pitchLogId = s(opts.pitchLogId);
  if (!resendMessageId && !pitchLogId) return { updated_ids: [] };

  const logCols = "id, draft_id, playlist_id, track_id, status, placement_status, resend_message_id, sent_at, pitched_at";
  const logQuery = sb.from("pitch_log").select(logCols);
  const { data: logs, error: logErr } = resendMessageId
    ? await logQuery.eq("resend_message_id", resendMessageId)
    : await logQuery.eq("id", pitchLogId);
  if (logErr) return { updated_ids: [], error: logErr.message };

  const bouncedLogs = ((logs ?? []) as Record<string, unknown>[]).filter(pitchBounced);
  if (!bouncedLogs.length) return { updated_ids: [] };

  const found = new Map<string, Record<string, unknown>>();
  const logByHandoff = new Map<string, Record<string, unknown>>();
  const cols = "id, queue_state, submission_channel, packet, outreach_draft_id, playlist_target_id";

  for (const log of bouncedLogs) {
    const draftIds = new Set<string>();
    const fromLog = s(log.draft_id);
    if (fromLog) draftIds.add(fromLog);
    const { data: linkedDrafts, error: draftErr } = await sb.from("outreach_drafts")
      .select("id, generated_by")
      .eq("pitch_log_id", String(log.id));
    if (draftErr) return { updated_ids: [], error: draftErr.message };
    for (const draft of (linkedDrafts ?? []) as Record<string, unknown>[]) {
      if (s(draft.id)) draftIds.add(s(draft.id));
    }
    for (const draftId of draftIds) {
      const { data, error } = await sb.from("agh_handoff_records").select(cols).eq("outreach_draft_id", draftId);
      if (error) return { updated_ids: [...found.keys()], error: error.message };
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = String(row.id);
        if (!found.has(id)) {
          found.set(id, row);
          logByHandoff.set(id, log);
        }
      }
    }
  }

  const fendi = await loadFendiDraftIds(sb, [...found.values()].map((row) => s(row.outreach_draft_id)));
  if (fendi.error) return { updated_ids: [], error: fendi.error };
  const targets = await loadTargets(sb, [...found.values()].map((row) => s(row.playlist_target_id)));
  if (targets.error) return { updated_ids: [], error: targets.error };

  const updated: string[] = [];
  for (const [id, row] of found) {
    const state = s(row.queue_state);
    if (state !== "SENT" && !SENT_FROM.has(state)) continue;
    if (skipRow(row, fendi.ids, targets.byId)) continue;
    const log = logByHandoff.get(id) ?? {};
    const providerId = s(log.resend_message_id) || resendMessageId;
    const packet = asPacket(row.packet);
    const prev = asPacket(packet.email_dispatch);
    const prior = s(prev.prior_queue_state);
    const already = s(prev.outcome) === "bounced" && s(prev.resend_message_id) === providerId;
    const restore = state === "SENT" && SENT_FROM.has(prior);
    if (already && !restore) continue;
    packet.email_dispatch = {
      ...prev,
      pitch_log_id: s(log.id) || s(prev.pitch_log_id),
      resend_message_id: providerId,
      channel: "email",
      outcome: "bounced",
      bounced_at: opts.bouncedAt,
    };
    const patch: Record<string, unknown> = { packet, updated_at: opts.bouncedAt };
    if (restore) patch.queue_state = prior;
    const { data, error } = await sb.from("agh_handoff_records")
      .update(patch)
      .eq("id", id)
      .eq("queue_state", state)
      .select("id");
    if (error) return { updated_ids: updated, error: error.message };
    if ((data ?? []).length) updated.push(id);
  }
  return { updated_ids: updated };
}
