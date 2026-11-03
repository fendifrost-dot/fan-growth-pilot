/**
 * Sync song allowlist. One ops_settings value, not a title branch in the send path.
 * ops_settings.sync_song_allowlist is a JSON array of track names or track ids.
 * Fendi adds a song by editing that array. An explicit empty array pauses sync.
 * A missing row uses the same seed as the migration (one name).
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  inDiscoveryScope,
  loadSyncResearchConfig,
  syncResearchConfigVacant,
  trackResearchStatus,
} from "./sync-research-config.ts";

export const SYNC_SONG_ALLOWLIST_KEY = "sync_song_allowlist";

/** Used only when the ops_settings row is absent. Matches the migration seed. */
export const DEFAULT_SYNC_SONG_ALLOWLIST = ["Meditate"];

export const SYNC_SONG_NOT_ALLOWLISTED = "sync_song_not_allowlisted";
export const FENDI_AUTHORED_GENERATED_BY = "fendi";

export type SyncGateResult = { status: number; data: Record<string, unknown> };

/** null when the value is absent. [] is an explicit pause. */
export function parseSyncSongAllowlist(raw: unknown): string[] | null {
  if (raw == null) return null;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { songs?: unknown }).songs)
    ? (raw as { songs: unknown[] }).songs
    : null;
  if (!list) return [];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

export function songOnAllowlist(
  allow: readonly string[],
  track: { id?: unknown; name?: unknown },
): boolean {
  const name = String(track.name ?? "").trim().toLowerCase();
  const id = String(track.id ?? "").trim().toLowerCase();
  return allow.some((entry) => {
    const value = entry.trim().toLowerCase();
    if (!value) return false;
    if (name && value === name) return true;
    return Boolean(id) && value === id;
  });
}

export async function loadSyncSongAllowlist(sb: SupabaseClient): Promise<string[]> {
  const { data, error } = await sb
    .from("ops_settings")
    .select("setting_value")
    .eq("setting_key", SYNC_SONG_ALLOWLIST_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  if (!data) return [...DEFAULT_SYNC_SONG_ALLOWLIST];
  const parsed = parseSyncSongAllowlist(data.setting_value);
  return parsed ?? [...DEFAULT_SYNC_SONG_ALLOWLIST];
}

export async function allowlistedTrackIds(sb: SupabaseClient): Promise<string[]> {
  const allow = await loadSyncSongAllowlist(sb);
  const { data, error } = await sb.from("tracks").select("id, name");
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((track) => songOnAllowlist(allow, track as { id?: unknown; name?: unknown }))
    .map((track) => String((track as { id: unknown }).id));
}

export async function enforceSyncSongAllowlist(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncGateResult | null> {
  const id = trackId.trim();
  if (!id) {
    return {
      status: 422,
      data: { error: "track_id required", code: SYNC_SONG_NOT_ALLOWLISTED },
    };
  }
  const { data: track, error } = await sb
    .from("tracks")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (error) return { status: 500, data: { error: error.message } };
  if (!track) {
    return {
      status: 404,
      data: { error: "track not found", code: "track_not_found", track_id: id },
    };
  }
  const allow = await loadSyncSongAllowlist(sb);
  if (!songOnAllowlist(allow, track as { id?: unknown; name?: unknown })) {
    return {
      status: 422,
      data: {
        error: "Song is not on the sync allowlist",
        code: SYNC_SONG_NOT_ALLOWLISTED,
        track_id: id,
        track_name: (track as { name?: unknown }).name ?? null,
      },
    };
  }
  return null;
}

/**
 * Allowlist first, then the older research-config scope when that config exists.
 * A vacant config (production before the seed) does not block an allowlisted song.
 */
export async function guardSyncResearchTrack(
  sb: SupabaseClient,
  trackId: string,
): Promise<SyncGateResult | null> {
  const blocked = await enforceSyncSongAllowlist(sb, trackId);
  if (blocked) return blocked;
  const config = await loadSyncResearchConfig(sb);
  if (!syncResearchConfigVacant(config) && !inDiscoveryScope(config, trackId)) {
    return {
      status: 422,
      data: {
        error: "track not in Fendi operating scope for sync research",
        code: "sync_research_track_inactive",
        track_id: trackId,
        status: trackResearchStatus(config, trackId),
      },
    };
  }
  return null;
}

export function fendiAuthoredRow(row: { generated_by?: unknown } | null | undefined): boolean {
  return String(row?.generated_by ?? "").trim().toLowerCase() === FENDI_AUTHORED_GENERATED_BY;
}

export function fendiAuthoredRefusal(): SyncGateResult {
  return {
    status: 409,
    data: {
      error: "generated_by=fendi rows are not modified or auto-sent",
      code: "fendi_authored_immutable",
    },
  };
}

/** Hub-created rows stay editable. The literal fendi marker is reserved for outside copy. */
export function stampSyncGeneratedBy(actorKind: string): string {
  if (actorKind === FENDI_AUTHORED_GENERATED_BY) return "fendi_hub";
  return actorKind;
}
