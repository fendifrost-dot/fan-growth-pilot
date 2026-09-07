/**
 * Idempotency, existing-target classification, and compensating cleanup for
 * Claude playlist-discovery inventory.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { OpsActor } from "./ops-actors.ts";
import { enforceTrackDnaLaneEnvelope } from "./track-dna-envelope.ts";
import { VERIFIED_STATUSES } from "./verify-target.ts";

export type ExistingTargetClass =
  | "existing_verified_eligible"
  | "existing_unverified"
  | "existing_pair_already_drafted"
  | "existing_pair_already_pitched"
  | "existing_pair_cooldown"
  | "existing_incompatible";

export function inventoryIdempotencyKey(
  trackId: string,
  playlistId: string,
  channel: string,
  songDnaVersionId: string,
): string {
  return `${trackId}:${playlistId}:${channel}:${songDnaVersionId}`;
}

export function isVerifiedEligibleRow(row: Record<string, unknown>): boolean {
  const pathOk = row.path_verified === true;
  const status = String(row.verification_status ?? "");
  return pathOk && (VERIFIED_STATUSES as readonly string[]).includes(status);
}

export async function classifyExistingPlaylistTarget(
  sb: SupabaseClient,
  opts: {
    trackId: string;
    playlistId: string;
    songDnaVersionId: string;
    actor: OpsActor;
    trackName?: string | null;
  },
): Promise<{
  classification: ExistingTargetClass;
  playlist_id: string;
  channel: string | null;
  reason?: string;
  outreach_draft_id?: string | null;
  handoff_record_id?: string | null;
  cooldown_until?: string | null;
}> {
  const { data: target, error } = await sb
    .from("playlist_targets")
    .select(
      "playlist_id, contact_method, submission_method, path_verified, verification_status, lane, curator_email, form_url, ig_curator_account",
    )
    .eq("playlist_id", opts.playlistId)
    .maybeSingle();
  if (error) {
    return {
      classification: "existing_incompatible",
      playlist_id: opts.playlistId,
      channel: null,
      reason: `target_lookup_failed:${error.message}`,
    };
  }
  if (!target) {
    return {
      classification: "existing_incompatible",
      playlist_id: opts.playlistId,
      channel: null,
      reason: "target_missing",
    };
  }

  const contact = String(target.contact_method ?? "").trim().toLowerCase();
  const submission = String(target.submission_method ?? "").trim().toLowerCase();
  const channel =
    ["email", "web_form", "instagram_dm"].includes(contact)
      ? contact
      : ["email", "web_form", "instagram_dm"].includes(submission)
      ? submission
      : null;

  if (!isVerifiedEligibleRow(target as Record<string, unknown>)) {
    return {
      classification: "existing_unverified",
      playlist_id: opts.playlistId,
      channel,
      reason: String(target.verification_status ?? "unverified"),
    };
  }

  const lane = await enforceTrackDnaLaneEnvelope(sb, {
    route: "classify_existing_playlist_target",
    trackId: opts.trackId,
    playlistId: opts.playlistId,
    callerSongDnaVersionId: opts.songDnaVersionId,
    actor: opts.actor,
  });
  if (!lane.ok) {
    return {
      classification: "existing_incompatible",
      playlist_id: opts.playlistId,
      channel,
      reason: lane.errors[0] ?? "dna_lane_rejected",
    };
  }

  // Open handoff for this track+playlist+channel+DNA
  if (channel) {
    const { data: handoff } = await sb
      .from("agh_handoff_records")
      .select("id, outreach_draft_id, queue_state")
      .eq("track_id", opts.trackId)
      .eq("playlist_target_id", opts.playlistId)
      .eq("submission_channel", channel)
      .eq("song_dna_version_id", opts.songDnaVersionId)
      .not("queue_state", "in", "(REJECTED_BY_GROK,IMPORTED_TO_AGH)")
      .limit(1)
      .maybeSingle();
    if (handoff?.id) {
      return {
        classification: "existing_pair_already_drafted",
        playlist_id: opts.playlistId,
        channel,
        outreach_draft_id: handoff.outreach_draft_id
          ? String(handoff.outreach_draft_id)
          : null,
        handoff_record_id: String(handoff.id),
      };
    }
  }

  const key = channel
    ? inventoryIdempotencyKey(
      opts.trackId,
      opts.playlistId,
      channel,
      opts.songDnaVersionId,
    )
    : null;
  if (key) {
    const { data: draft } = await sb
      .from("outreach_drafts")
      .select("id, status")
      .eq("ops_idempotency_key", key)
      .in("status", ["pending", "approved"])
      .limit(1)
      .maybeSingle();
    if (draft?.id) {
      return {
        classification: "existing_pair_already_drafted",
        playlist_id: opts.playlistId,
        channel,
        outreach_draft_id: String(draft.id),
      };
    }
  }

  // Also catch drafts without idempotency key (legacy) for same track+playlist pending.
  const { data: legacyDraft } = await sb
    .from("outreach_drafts")
    .select("id, status, channel")
    .eq("track_id", opts.trackId)
    .eq("playlist_id", opts.playlistId)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();
  if (legacyDraft?.id) {
    return {
      classification: "existing_pair_already_drafted",
      playlist_id: opts.playlistId,
      channel: channel ?? (legacyDraft.channel ? String(legacyDraft.channel) : null),
      outreach_draft_id: String(legacyDraft.id),
    };
  }

  // Pitch / cooldown — pitch_log is track_name keyed historically.
  const trackName = opts.trackName ?? null;
  if (trackName) {
    const nowIso = new Date().toISOString();
    const { data: cool } = await sb
      .from("pitch_log")
      .select("id, cooldown_until, status")
      .eq("playlist_id", opts.playlistId)
      .eq("track_name", trackName)
      .eq("status", "sent")
      .gt("cooldown_until", nowIso)
      .limit(1)
      .maybeSingle();
    if (cool?.id) {
      return {
        classification: "existing_pair_cooldown",
        playlist_id: opts.playlistId,
        channel,
        cooldown_until: cool.cooldown_until ? String(cool.cooldown_until) : null,
      };
    }
    const { data: pitched } = await sb
      .from("pitch_log")
      .select("id, cooldown_until, status")
      .eq("playlist_id", opts.playlistId)
      .eq("track_name", trackName)
      .eq("status", "sent")
      .limit(1)
      .maybeSingle();
    if (pitched?.id) {
      // Past cooldown → still "already pitched" for this pair (may re-pitch later via policy).
      const until = pitched.cooldown_until ? String(pitched.cooldown_until) : null;
      if (until && new Date(until).getTime() > Date.now()) {
        return {
          classification: "existing_pair_cooldown",
          playlist_id: opts.playlistId,
          channel,
          cooldown_until: until,
        };
      }
      return {
        classification: "existing_pair_already_pitched",
        playlist_id: opts.playlistId,
        channel,
        cooldown_until: until,
      };
    }
  }

  return {
    classification: "existing_verified_eligible",
    playlist_id: opts.playlistId,
    channel,
  };
}

export async function lookupInventoryPair(
  sb: SupabaseClient,
  opts: {
    trackId: string;
    playlistId: string;
    channel: string;
    songDnaVersionId: string;
  },
): Promise<Record<string, unknown>> {
  const { data, error } = await sb.rpc("agh_mcp_lookup_inventory_pair", {
    p_track_id: opts.trackId,
    p_playlist_id: opts.playlistId,
    p_channel: opts.channel,
    p_song_dna_version_id: opts.songDnaVersionId,
  });
  if (error) {
    // Fallback query when RPC not applied yet.
    const key = inventoryIdempotencyKey(
      opts.trackId,
      opts.playlistId,
      opts.channel,
      opts.songDnaVersionId,
    );
    const { data: draft } = await sb
      .from("outreach_drafts")
      .select("id, status")
      .eq("ops_idempotency_key", key)
      .in("status", ["pending", "approved"])
      .limit(1)
      .maybeSingle();
    const { data: rec } = await sb
      .from("agh_handoff_records")
      .select("id, batch_id, outreach_draft_id")
      .eq("track_id", opts.trackId)
      .eq("playlist_target_id", opts.playlistId)
      .eq("submission_channel", opts.channel)
      .eq("song_dna_version_id", opts.songDnaVersionId)
      .not("queue_state", "in", "(REJECTED_BY_GROK,IMPORTED_TO_AGH)")
      .limit(1)
      .maybeSingle();
    if (!draft && !rec) return { ok: true, found: false, idempotency_key: key };
    return {
      ok: true,
      found: true,
      idempotency_key: key,
      outreach_draft_id: draft?.id ?? rec?.outreach_draft_id ?? null,
      draft_status: draft?.status ?? null,
      handoff_record_id: rec?.id ?? null,
      batch_id: rec?.batch_id ?? null,
    };
  }
  return (data ?? { ok: true, found: false }) as Record<string, unknown>;
}

export async function compensateInventoryFailure(
  sb: SupabaseClient,
  opts: {
    batchId: string | null;
    orphanDraftKeys: string[];
  },
): Promise<{ ok: boolean; errors: string[]; drafts_deleted?: number; batch_deleted?: boolean }> {
  const errors: string[] = [];
  let draftsDeleted = 0;
  let batchDeleted = false;

  if (opts.orphanDraftKeys.length) {
    const { data, error } = await sb.rpc("agh_mcp_delete_orphan_drafts", {
      p_keys: opts.orphanDraftKeys,
    });
    if (error) {
      // Fallback: delete directly
      const { error: delErr, count } = await sb
        .from("outreach_drafts")
        .delete({ count: "exact" })
        .in("ops_idempotency_key", opts.orphanDraftKeys)
        .eq("status", "pending");
      if (delErr) errors.push(`orphan_draft_delete:${delErr.message}`);
      else draftsDeleted = count ?? 0;
    } else {
      const r = (data ?? {}) as Record<string, unknown>;
      if (!r.ok) errors.push(`orphan_draft_rpc:${String(r.error ?? "failed")}`);
      else draftsDeleted = Number(r.deleted ?? 0);
    }
  }

  if (opts.batchId) {
    const { data, error } = await sb.rpc("agh_mcp_delete_empty_handoff_batch", {
      p_batch_id: opts.batchId,
    });
    if (error) {
      const { data: batch } = await sb
        .from("agh_handoff_batches")
        .select("id, record_count")
        .eq("id", opts.batchId)
        .maybeSingle();
      if (batch && Number(batch.record_count ?? 0) === 0) {
        const { error: delErr, count } = await sb
          .from("agh_handoff_batches")
          .delete({ count: "exact" })
          .eq("id", opts.batchId);
        if (delErr || count !== 1) {
          errors.push(`empty_batch_delete:${delErr?.message ?? "affected_0"}`);
        } else batchDeleted = true;
      } else if (batch) {
        errors.push(`empty_batch_delete:not_empty:${batch.record_count}`);
      } else {
        errors.push(`empty_batch_delete:${error.message}`);
      }
    } else {
      const r = (data ?? {}) as Record<string, unknown>;
      if (!r.ok) errors.push(`empty_batch_rpc:${String(r.code ?? r.error ?? "failed")}`);
      else batchDeleted = true;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    drafts_deleted: draftsDeleted,
    batch_deleted: batchDeleted,
  };
}

/** Assert DB write result — never silently ignore failures. */
export function assertWriteOk(
  label: string,
  error: { message?: string; code?: string } | null | undefined,
  count?: number | null,
  expectCount?: number,
): { ok: true } | { ok: false; error: string } {
  if (error) return { ok: false, error: `${label}:${error.message ?? "error"}` };
  if (expectCount != null && count != null && count !== expectCount) {
    return { ok: false, error: `${label}:affected_${count}_expected_${expectCount}` };
  }
  return { ok: true };
}
