/**
 * Web-form handoff queue. Listing is a read. Approve, reject, and mark-submitted
 * stay on the existing gated actions. Nothing here sends outreach.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { can, type OpsActor } from "./ops-actors.ts";

type RunResult = { status: number; data: Record<string, unknown> };

const OPEN_STATES = ["AWAITING_GROK_REVIEW", "GROK_REVIEWED", "APPROVED_FOR_SEND"] as const;
const APPROVERS = new Set(["fendi", "grok_playlist_control"]);

function packetOf(row: Record<string, unknown>): Record<string, unknown> {
  const packet = row.packet;
  return packet && typeof packet === "object" && !Array.isArray(packet) ? packet as Record<string, unknown> : {};
}

/** Plain-language reasons an operator cannot mark this web form submitted yet. */
export function webFormBlockers(row: Record<string, unknown>): string[] {
  const blockers: string[] = [];
  const state = String(row.queue_state ?? "");
  const packet = packetOf(row);
  const review = packet.grok_review && typeof packet.grok_review === "object"
    ? packet.grok_review as Record<string, unknown>
    : {};
  const verdict = String(review.verdict ?? "").trim();
  const approvedBy = String(row.approved_by ?? "").trim();
  if (row.submitted_at) blockers.push("This form is already marked submitted.");
  if (!row.track_id) blockers.push("This record has no song attached.");
  if (!row.playlist_target_id) blockers.push("This record has no playlist attached.");
  if (packet.route_hold) blockers.push("This playlist is on hold. Clear the hold before submitting.");
  if (packet.review_defer) blockers.push("Review was deferred. Finish the review before submitting.");
  if (state === "AWAITING_GROK_REVIEW") {
    blockers.push("This form is still waiting for review. Approve it before marking it submitted.");
  } else if (state === "GROK_REVIEWED") {
    blockers.push("This form is reviewed but not approved for sending yet.");
  } else if (state !== "APPROVED_FOR_SEND") {
    blockers.push(`This form is ${state || "in an unknown state"} and cannot be marked submitted.`);
  } else if (verdict && verdict !== "PASS") {
    blockers.push(`The review verdict is ${verdict}. Only a PASS can be marked submitted.`);
  } else if (verdict !== "PASS" && !APPROVERS.has(approvedBy)) {
    blockers.push("The approval stamp is missing. Fendi or Grok Playlist Control has to approve this form first.");
  }
  const channel = String(row.submission_channel ?? "").trim();
  if (channel && channel !== "web_form") {
    blockers.push(`This record is a ${channel} submission, not a web form.`);
  }
  return blockers;
}

/** Turn a manual-submit database exception into a sentence the operator can act on. */
export function plainManualSubmitError(message: string): { code: string; error: string } | null {
  const raw = message.trim();
  if (raw.includes("pass_approval_required")) {
    return {
      code: "pass_approval_required",
      error: "This form is not approved for sending. It needs a PASS from Fendi or Grok Playlist Control before it can be marked submitted.",
    };
  }
  if (raw.includes("record_held")) {
    return {
      code: "record_held",
      error: "This playlist is on hold or the review was deferred. Clear that before marking it submitted.",
    };
  }
  if (raw.includes("submission_evidence_required")) {
    return {
      code: "submission_evidence_required",
      error: "Marking a form submitted needs a confirmation: result submitted, a reference, notes, and the time you submitted it.",
    };
  }
  if (raw.includes("dna_gate")) {
    return {
      code: "dna_gate",
      error: "Song DNA does not allow this playlist's lane, so the form cannot be marked submitted.",
    };
  }
  const conflict = raw.match(/playlist_policy:cooldown_conflict:([0-9a-f-]{36})/i);
  if (conflict) {
    return {
      code: "cooldown_conflict",
      error: `This curator is in a 90-day cooldown across every channel. Prior pitch ${conflict[1]}.`,
    };
  }
  const policy = raw.match(/playlist_policy:([a-z0-9_]+)/i);
  if (policy) {
    const code = policy[1].toLowerCase();
    const text: Record<string, string> = {
      curator_cooldown: "This curator is still in cooldown for this song.",
      cooldown_conflict: "This curator is in a 90-day cooldown across every channel.",
      suppressed_curator: "This curator is blocked on this channel.",
      paid_curator: "This curator asks for payment. Paid playlists stay blocked.",
      blocked_domain: "This curator's email domain is blocked.",
      inactive_target: "This playlist is inactive.",
      identity_required: "This record is missing a playlist or a song.",
    };
    return { code, error: text[code] ?? `Playlist policy blocked this submit (${code}).` };
  }
  return null;
}

export async function listWebFormHandoffs(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  ops: OpsActor,
): Promise<RunResult> {
  if (!can(ops, "read_playlist_ops")) {
    return { status: 403, data: { error: `${ops.label} cannot read the web form queue` } };
  }
  const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 250);
  const { data, error, count } = await sb
    .from("agh_handoff_records")
    .select(
      "id, batch_id, track_id, playlist_target_id, queue_state, submission_channel, song_dna_version_id, approved_by, packet, submitted_at, updated_at",
      { count: "exact" },
    )
    .eq("submission_channel", "web_form")
    .is("submitted_at", null)
    .in("queue_state", [...OPEN_STATES])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return { status: 500, data: { error: error.message } };
  const rows = (data ?? []) as Record<string, unknown>[];
  const trackIds = [...new Set(rows.map((r) => String(r.track_id ?? "")).filter(Boolean))];
  const playlistIds = [...new Set(rows.map((r) => String(r.playlist_target_id ?? "")).filter(Boolean))];
  const trackNames = new Map<string, string>();
  if (trackIds.length) {
    const { data: tracks, error: trackErr } = await sb.from("tracks").select("id, name").in("id", trackIds);
    if (trackErr) return { status: 500, data: { error: trackErr.message } };
    for (const row of (tracks ?? []) as { id: string; name: string }[]) trackNames.set(String(row.id), String(row.name ?? ""));
  }
  const playlists = new Map<string, { name: string; form_url: string | null }>();
  if (playlistIds.length) {
    const { data: targets, error: targetErr } = await sb
      .from("playlist_targets")
      .select("playlist_id, playlist_name, form_url")
      .in("playlist_id", playlistIds);
    if (targetErr) return { status: 500, data: { error: targetErr.message } };
    for (const row of (targets ?? []) as { playlist_id: string; playlist_name: string; form_url: string | null }[]) {
      playlists.set(String(row.playlist_id), {
        name: String(row.playlist_name ?? ""),
        form_url: row.form_url ? String(row.form_url) : null,
      });
    }
  }
  return {
    status: 200,
    data: {
      ok: true,
      total_count: typeof count === "number" ? count : rows.length,
      rows: rows.map((row) => {
        const playlist = playlists.get(String(row.playlist_target_id ?? ""));
        return {
          id: row.id,
          batch_id: row.batch_id,
          track_id: row.track_id,
          track_name: trackNames.get(String(row.track_id ?? "")) ?? null,
          playlist_target_id: row.playlist_target_id,
          playlist_name: playlist?.name ?? null,
          form_url: playlist?.form_url ?? null,
          queue_state: row.queue_state,
          submission_channel: row.submission_channel,
          approved_by: row.approved_by ?? null,
          blockers: webFormBlockers(row),
        };
      }),
    },
  };
}
