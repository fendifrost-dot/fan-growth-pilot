/**
 * Instagram DM send queue — the approved Instagram path, as data.
 *
 *   1. claude_playlist_discovery finds the curator and composes the DM inside
 *      the Hub (outreach_drafts, channel instagram_dm).
 *   2. grok_playlist_control reviews the handoff record and approves the draft.
 *   3. Muse (the Control Center chief of staff, credential muse_ig_receipt)
 *      reads this queue, sends the DM on Instagram, and records the receipt
 *      with mark_manual_ig_dm_submitted.
 *
 * This module is read-only. It never approves, never sends, never writes.
 * It exposes the approved DM text and the handle to the sender and nothing
 * else: no emails, no secrets, no unapproved copy.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { can, type OpsActor } from "./ops-actors.ts";

type RunResult = { status: number; data: Record<string, unknown> };
type Row = Record<string, unknown>;

export const IG_SEND_OWNER = "muse";
export const IG_RECEIPT_ACTION = "mark_manual_ig_dm_submitted";
export const IG_SEND_PATH = [
  "claude_playlist_discovery composes the DM in the Hub (create_playlist_draft_inventory)",
  "grok_playlist_control reviews the handoff record and approves the draft",
  "muse reads list_ig_dm_send_queue and sends the DM on Instagram",
  "muse records the receipt with mark_manual_ig_dm_submitted",
] as const;

/** Muse, Grok and Fendi may read the queue. Discovery credentials may not. */
export function igSendQueueReadable(ops: OpsActor): boolean {
  if (ops.kind === "muse_ig_receipt" || ops.kind === "fendi") return true;
  if (ops.kind === "claude_playlist_discovery" || ops.kind === "claude_sync_discovery") return false;
  return can(ops, "read_playlist_ops");
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function meta(row: Row): Row {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? m as Row : {};
}

function packet(row: Row): Row {
  const p = row.packet;
  return p && typeof p === "object" && !Array.isArray(p) ? p as Row : {};
}

/** "@handle" from any stored spelling; null when nothing usable is stored. */
export function igHandleOf(...candidates: unknown[]): string | null {
  for (const raw of candidates) {
    const s = str(raw).replace(/^@+/, "");
    if (!s) continue;
    if (/^https?:\/\//i.test(s) || s.includes("/")) continue;
    if (!/^[A-Za-z0-9._]{2,30}$/.test(s)) continue;
    return `@${s}`;
  }
  return null;
}

function attributionHeld(draft: Row): boolean {
  const m = meta(draft);
  return [draft.generated_by, draft.drafted_by, m.generated_by, m.drafted_by]
    .some((v) => str(v).toLowerCase() === "fendi");
}

/**
 * The approved draft for a record: the linked one when it is approved,
 * else an approved instagram_dm draft for the same track + playlist that
 * points back at this record, else the oldest approved one for the pair.
 */
export function pickSendDraft(record: Row, drafts: Row[]): Row | null {
  const linkedId = str(record.outreach_draft_id);
  const sameChannel = drafts.filter((d) => str(d.channel) === "instagram_dm");
  if (linkedId) {
    const linked = sameChannel.find((d) => str(d.id) === linkedId);
    if (linked) return linked;
  }
  const pair = sameChannel.filter((d) =>
    str(d.track_id) === str(record.track_id) && str(d.playlist_id) === str(record.playlist_target_id) &&
    str(d.status) === "approved"
  );
  const pointed = pair.find((d) => str(meta(d).handoff_record_id) === str(record.id));
  if (pointed) return pointed;
  pair.sort((a, b) => str(a.generated_at || a.created_at).localeCompare(str(b.generated_at || b.created_at)));
  return pair[0] ?? null;
}

export function sendQueueRow(
  record: Row,
  draft: Row | null,
  target: Row | null,
  trackName: string | null,
): Row {
  const blockers: string[] = [];
  const body = draft ? str(draft.body) : "";
  const handle = igHandleOf(
    draft?.recipient,
    packet(record).ig_curator_account,
    target?.ig_curator_account,
    target?.curator_instagram,
  );
  if (!draft) blockers.push("draft_missing");
  else {
    if (str(draft.status) !== "approved") blockers.push(`draft_${str(draft.status) || "unknown"}`);
    if (!body) blockers.push("draft_body_empty");
    if (attributionHeld(draft)) blockers.push("attribution_held");
  }
  if (!handle) blockers.push("ig_handle_missing");
  if (target && target.is_active === false) blockers.push("target_inactive");
  return {
    handoff_record_id: record.id,
    batch_id: record.batch_id ?? null,
    track_id: record.track_id ?? null,
    track_name: trackName,
    playlist_target_id: record.playlist_target_id ?? null,
    playlist_name: target ? str(target.playlist_name) || null : null,
    ig_handle: handle,
    ig_url: handle ? `https://instagram.com/${handle.slice(1)}` : null,
    dm_body: blockers.length ? null : body,
    outreach_draft_id: draft ? draft.id : null,
    draft_status: draft ? draft.status ?? null : null,
    generated_by: draft ? draft.generated_by ?? null : null,
    record_approved_by: record.approved_by ?? null,
    draft_approved_by: draft ? draft.approved_by ?? null : null,
    draft_approved_at: draft ? draft.approved_at ?? null : null,
    queue_state: record.queue_state ?? null,
    send_owner: IG_SEND_OWNER,
    receipt_action: IG_RECEIPT_ACTION,
    sendable: blockers.length === 0,
    blockers,
  };
}

/**
 * Approved, unsent Instagram handoffs with their approved DM text.
 * Rows that cannot be sent are returned with `sendable: false` and the reason,
 * so the sender never guesses and the reviewer can see what is stuck.
 */
export async function listIgDmSendQueue(
  sb: SupabaseClient,
  body: Row,
  ops: OpsActor,
): Promise<RunResult> {
  if (!igSendQueueReadable(ops)) {
    return { status: 403, data: { error: `${ops.label} cannot read the Instagram send queue`, code: "forbidden" } };
  }
  const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 250);
  const { data, error, count } = await sb
    .from("agh_handoff_records")
    .select(
      "id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, approved_by, outreach_draft_id, packet, submitted_at, updated_at",
      { count: "exact" },
    )
    .eq("submission_channel", "instagram_dm")
    .eq("queue_state", "APPROVED_FOR_SEND")
    .is("submitted_at", null)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return { status: 500, data: { error: error.message, code: "db_error" } };
  const records = (data ?? []) as Row[];

  const trackIds = [...new Set(records.map((r) => str(r.track_id)).filter(Boolean))];
  const playlistIds = [...new Set(records.map((r) => str(r.playlist_target_id)).filter(Boolean))];

  const trackNames = new Map<string, string>();
  if (trackIds.length) {
    const { data: tracks, error: tErr } = await sb.from("tracks").select("id, name").in("id", trackIds);
    if (tErr) return { status: 500, data: { error: tErr.message, code: "db_error" } };
    for (const t of (tracks ?? []) as Row[]) trackNames.set(str(t.id), str(t.name));
  }

  const targets = new Map<string, Row>();
  if (playlistIds.length) {
    const { data: rows, error: pErr } = await sb
      .from("playlist_targets")
      .select("playlist_id, playlist_name, ig_curator_account, curator_instagram, curator_name, is_active, pitch_status")
      .in("playlist_id", playlistIds);
    if (pErr) return { status: 500, data: { error: pErr.message, code: "db_error" } };
    for (const t of (rows ?? []) as Row[]) targets.set(str(t.playlist_id), t);
  }

  let drafts: Row[] = [];
  if (playlistIds.length) {
    const { data: rows, error: dErr } = await sb
      .from("outreach_drafts")
      .select("id, track_id, playlist_id, channel, status, body, recipient, generated_by, approved_by, approved_at, generated_at, created_at, metadata")
      .eq("channel", "instagram_dm")
      .in("playlist_id", playlistIds);
    if (dErr) return { status: 500, data: { error: dErr.message, code: "db_error" } };
    drafts = (rows ?? []) as Row[];
  }

  const out = records.map((r) =>
    sendQueueRow(r, pickSendDraft(r, drafts), targets.get(str(r.playlist_target_id)) ?? null, trackNames.get(str(r.track_id)) ?? null)
  );
  return {
    status: 200,
    data: {
      ok: true,
      send_owner: IG_SEND_OWNER,
      receipt_action: IG_RECEIPT_ACTION,
      path: [...IG_SEND_PATH],
      total_count: typeof count === "number" ? count : out.length,
      sendable_count: out.filter((r) => r.sendable).length,
      rows: out,
    },
  };
}
