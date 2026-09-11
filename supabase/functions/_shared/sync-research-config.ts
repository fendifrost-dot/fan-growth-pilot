/**
 * Operator-controlled sync research campaign configuration.
 * Source of truth: ops_settings.sync_research_config — never track-title literals.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export const SYNC_RESEARCH_SETTING_KEY = "sync_research_config";

export const SYNC_TRACK_STATUSES = [
  "active_research",
  "inactive",
  "blocked",
] as const;

export type SyncTrackStatus = (typeof SYNC_TRACK_STATUSES)[number];

export type SyncResearchTrackEntry = {
  status: SyncTrackStatus;
  label?: string;
  notes?: string;
};

export type SyncResearchConfig = {
  version: number;
  default_status: SyncTrackStatus;
  tracks: Record<string, SyncResearchTrackEntry>;
};

export const DEFAULT_SYNC_RESEARCH_CONFIG: SyncResearchConfig = {
  version: 1,
  default_status: "inactive",
  tracks: {},
};

export function isSyncTrackStatus(v: string): v is SyncTrackStatus {
  return (SYNC_TRACK_STATUSES as readonly string[]).includes(v);
}

export function parseSyncResearchConfig(raw: unknown): SyncResearchConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SYNC_RESEARCH_CONFIG };
  const obj = raw as Record<string, unknown>;
  const defaultStatus = isSyncTrackStatus(String(obj.default_status ?? ""))
    ? (String(obj.default_status) as SyncTrackStatus)
    : "inactive";
  const tracksRaw =
    obj.tracks && typeof obj.tracks === "object" && !Array.isArray(obj.tracks)
      ? (obj.tracks as Record<string, unknown>)
      : {};
  const tracks: Record<string, SyncResearchTrackEntry> = {};
  for (const [id, entry] of Object.entries(tracksRaw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const status = isSyncTrackStatus(String(e.status ?? ""))
      ? (String(e.status) as SyncTrackStatus)
      : defaultStatus;
    tracks[String(id)] = {
      status,
      label: e.label != null ? String(e.label) : undefined,
      notes: e.notes != null ? String(e.notes) : undefined,
    };
  }
  return {
    version: Number(obj.version) || 1,
    default_status: defaultStatus,
    tracks,
  };
}

export async function loadSyncResearchConfig(
  sb: SupabaseClient,
): Promise<SyncResearchConfig> {
  const { data } = await sb
    .from("ops_settings")
    .select("setting_value")
    .eq("setting_key", SYNC_RESEARCH_SETTING_KEY)
    .maybeSingle();
  return parseSyncResearchConfig(data?.setting_value);
}

export function trackResearchStatus(
  config: SyncResearchConfig,
  trackId: string,
): SyncTrackStatus {
  const entry = config.tracks[trackId];
  return entry?.status ?? config.default_status;
}

export function isActiveResearchTrack(
  config: SyncResearchConfig,
  trackId: string,
): boolean {
  return trackResearchStatus(config, trackId) === "active_research";
}

export function activeResearchTrackIds(config: SyncResearchConfig): string[] {
  return Object.entries(config.tracks)
    .filter(([, e]) => e.status === "active_research")
    .map(([id]) => id);
}

/** Reject caller attempts to claim eligibility or override configured track set. */
export function rejectCallerSyncIdentity(body: Record<string, unknown>): string | null {
  for (const key of [
    "sync_eligible",
    "has_sample",
    "sync_approved_by",
    "sample_declaration_approved_by",
    "caller_eligibility",
    "claimed_eligible",
    "inferred_eligible",
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return `caller-supplied ${key} is rejected`;
    }
  }
  return null;
}
