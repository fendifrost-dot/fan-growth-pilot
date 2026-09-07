/**
 * Idempotency, existing-target classification, and emergency compensate for
 * Claude playlist-discovery inventory.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { OpsActor } from "./ops-actors.ts";
import { enforceTrackDnaLaneEnvelope } from "./track-dna-envelope.ts";
import { VERIFIED_STATUSES } from "./verify-target.ts";

export const ACTIVE_DRAFT_STATUSES = ["pending", "approved"] as const;

export type ExistingTargetClass =
  | "existing_verified_eligible"
  | "existing_unverified"
  | "existing_pair_already_drafted"
  | "existing_pair_already_pitched"
  | "existing_pair_cooldown"
  | "existing_incompatible"
  | "classification_failed";

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

function classificationFailed(
  playlistId: string,
  channel: string | null,
  reason: string,
): {
  classification: "classification_failed";
  playlist_id: string;
  channel: string | null;
  reason: string;
  code: "db_error";
} {
  return {
    classification: "classification_failed",
    playlist_id: playlistId,
    channel,
    reason,
    code: "db_error",
  };
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
  code?: string;
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
    return classificationFailed(opts.playlistId, null, `target_lookup_failed:${error.message}`);
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

  if (channel) {
    const { data: handoff, error: handoffErr } = await sb
      .from("agh_handoff_records")
      .select("id, outreach_draft_id, queue_state")
      .eq("track_id", opts.trackId)
      .eq("playlist_target_id", opts.playlistId)
      .eq("submission_channel", channel)
      .eq("song_dna_version_id", opts.songDnaVersionId)
      .not("queue_state", "in", "(REJECTED_BY_GROK,IMPORTED_TO_AGH)")
      .limit(1)
      .maybeSingle();
    if (handoffErr) {
      return classificationFailed(
        opts.playlistId,
        channel,
        `handoff_lookup_failed:${handoffErr.message}`,
      );
    }
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
    const { data: draft, error: draftErr } = await sb
      .from("outreach_drafts")
      .select("id, status")
      .eq("ops_idempotency_key", key)
      .in("status", [...ACTIVE_DRAFT_STATUSES])
      .limit(1)
      .maybeSingle();
    if (draftErr) {
      return classificationFailed(
        opts.playlistId,
        channel,
        `idempotent_draft_lookup_failed:${draftErr.message}`,
      );
    }
    if (draft?.id) {
      return {
        classification: "existing_pair_already_drafted",
        playlist_id: opts.playlistId,
        channel,
        outreach_draft_id: String(draft.id),
      };
    }
  }

  const { data: legacyDraft, error: legacyErr } = await sb
    .from("outreach_drafts")
    .select("id, status, channel")
    .eq("track_id", opts.trackId)
    .eq("playlist_id", opts.playlistId)
    .in("status", [...ACTIVE_DRAFT_STATUSES])
    .limit(1)
    .maybeSingle();
  if (legacyErr) {
    return classificationFailed(
      opts.playlistId,
      channel,
      `legacy_draft_lookup_failed:${legacyErr.message}`,
    );
  }
  if (legacyDraft?.id) {
    return {
      classification: "existing_pair_already_drafted",
      playlist_id: opts.playlistId,
      channel: channel ?? (legacyDraft.channel ? String(legacyDraft.channel) : null),
      outreach_draft_id: String(legacyDraft.id),
    };
  }

  let trackName = opts.trackName ?? null;
  if (trackName == null) {
    const { data: trackRow, error: trackErr } = await sb
      .from("tracks")
      .select("id, name")
      .eq("id", opts.trackId)
      .maybeSingle();
    if (trackErr) {
      return classificationFailed(
        opts.playlistId,
        channel,
        `track_name_lookup_failed:${trackErr.message}`,
      );
    }
    trackName = trackRow?.name != null ? String(trackRow.name) : null;
  }

  if (trackName) {
    const nowIso = new Date().toISOString();
    const { data: cool, error: coolErr } = await sb
      .from("pitch_log")
      .select("id, cooldown_until, status")
      .eq("playlist_id", opts.playlistId)
      .eq("track_name", trackName)
      .eq("status", "sent")
      .gt("cooldown_until", nowIso)
      .limit(1)
      .maybeSingle();
    if (coolErr) {
      return classificationFailed(
        opts.playlistId,
        channel,
        `cooldown_lookup_failed:${coolErr.message}`,
      );
    }
    if (cool?.id) {
      return {
        classification: "existing_pair_cooldown",
        playlist_id: opts.playlistId,
        channel,
        cooldown_until: cool.cooldown_until ? String(cool.cooldown_until) : null,
      };
    }

    const { data: pitched, error: pitchedErr } = await sb
      .from("pitch_log")
      .select("id, cooldown_until, status")
      .eq("playlist_id", opts.playlistId)
      .eq("track_name", trackName)
      .eq("status", "sent")
      .limit(1)
      .maybeSingle();
    if (pitchedErr) {
      return classificationFailed(
        opts.playlistId,
        channel,
        `pitch_log_lookup_failed:${pitchedErr.message}`,
      );
    }
    if (pitched?.id) {
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
    if (/could not find|does not exist|PGRST202/i.test(error.message)) {
      return {
        ok: false,
        found: false,
        code: "migration_required",
        error: `lookup_rpc_missing:${error.message}`,
      };
    }
    return {
      ok: false,
      found: false,
      code: "db_error",
      error: `lookup_rpc_failed:${error.message}`,
    };
  }
  const row = (data ?? { ok: true, found: false }) as Record<string, unknown>;
  if (row.ok === false) return row;
  return row;
}

/**
 * Emergency fallback only — ordinary inventory failures must roll back via
 * agh_mcp_persist_playlist_inventory. Returns ok:false if clean state unproven.
 */
export async function compensateInventoryFailure(
  sb: SupabaseClient,
  opts: {
    batchId: string | null;
    orphanDraftIds: string[];
  },
): Promise<{ ok: boolean; errors: string[]; drafts_deleted?: number; records_deleted?: number; batch_deleted?: boolean }> {
  const { data, error } = await sb.rpc("agh_mcp_compensate_inventory_attempt", {
    p_batch_id: opts.batchId,
    p_draft_ids: opts.orphanDraftIds.length ? opts.orphanDraftIds : null,
  });
  if (error) {
    if (/could not find|does not exist|PGRST202/i.test(error.message)) {
      return {
        ok: false,
        errors: [`compensate_rpc_missing:${error.message}`],
      };
    }
    return { ok: false, errors: [`compensate_rpc_failed:${error.message}`] };
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (!r.ok) {
    return {
      ok: false,
      errors: [`compensate:${String(r.code ?? r.error ?? "failed")}`],
      drafts_deleted: Number(r.drafts_deleted ?? 0),
      records_deleted: Number(r.records_deleted ?? 0),
      batch_deleted: Boolean(r.batch_deleted),
    };
  }
  return {
    ok: true,
    errors: [],
    drafts_deleted: Number(r.drafts_deleted ?? 0),
    records_deleted: Number(r.records_deleted ?? 0),
    batch_deleted: Boolean(r.batch_deleted),
  };
}

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

export function isMigrationMissingRpc(error: { message?: string; code?: string } | null): boolean {
  if (!error?.message) return false;
  return /could not find|does not exist|PGRST202/i.test(error.message);
}
