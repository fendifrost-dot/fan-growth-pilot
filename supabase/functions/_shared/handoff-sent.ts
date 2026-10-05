/**
 * After a real email send, move the linked approved handoff record to SENT.
 * Does not insert pitch_log, receipts, or submitted_at, so quota is unchanged.
 * Does not send anything.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type HandoffSentResult = { updated_ids: string[]; error?: string };

function s(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function asPacket(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/**
 * Mark APPROVED_FOR_SEND email handoffs that belong to this send. Web forms and
 * Instagram DMs are left alone. A missing provider id does not move anything.
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

  if (draftId) {
    const { data, error } = await sb.from("agh_handoff_records")
      .select("id, queue_state, submission_channel, packet")
      .eq("outreach_draft_id", draftId)
      .eq("queue_state", "APPROVED_FOR_SEND");
    if (error) return { updated_ids: [], error: error.message };
    for (const row of (data ?? []) as Record<string, unknown>[]) found.set(String(row.id), row);
  }
  if (playlistId && trackId) {
    const { data, error } = await sb.from("agh_handoff_records")
      .select("id, queue_state, submission_channel, packet")
      .eq("playlist_target_id", playlistId)
      .eq("track_id", trackId)
      .eq("queue_state", "APPROVED_FOR_SEND");
    if (error) return { updated_ids: [...found.keys()], error: error.message };
    for (const row of (data ?? []) as Record<string, unknown>[]) found.set(String(row.id), row);
  }

  const updated: string[] = [];
  for (const [id, row] of found) {
    const channel = s(row.submission_channel) || "email";
    if (channel !== "email") continue;
    const packet = asPacket(row.packet);
    packet.email_dispatch = {
      pitch_log_id: pitchLogId,
      resend_message_id: resendMessageId,
      sent_at: opts.sentAt,
      channel: "email",
    };
    const { data, error } = await sb.from("agh_handoff_records")
      .update({
        queue_state: "SENT",
        packet,
        updated_at: opts.sentAt,
      })
      .eq("id", id)
      .eq("queue_state", "APPROVED_FOR_SEND")
      .select("id");
    if (error) return { updated_ids: updated, error: error.message };
    if ((data ?? []).length) updated.push(id);
  }
  return { updated_ids: updated };
}
