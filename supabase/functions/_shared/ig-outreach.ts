import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  isValidCuratorIgHandle,
  sanitizeCuratorIgHandle,
  isArtistIgHandle,
} from "./curator-filters.ts";
import { loadLanesConfig } from "./playlist-lanes.ts";

export const IG_DM_DAILY_CAP = 10;

const OPENERS_THANK = [
  "Hey — just saw you added my track to",
  "Hi! Really appreciate you including me on",
  "Thank you for supporting with a add on",
];

const OPENERS_PITCH = [
  "Since you're already vibing with my sound on",
  "Given the fit on",
  "Thought you might also like something new for",
];

const CLOSERS = [
  "No pressure at all — just wanted to say thanks and share the new one if it's useful.",
  "Grateful for the spin. Happy to send a different mix if you want it.",
  "Thanks again. Would mean a lot if you gave the new track a listen when you have a sec.",
];

function hashPick(seed: string, arr: string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

function featuringTracks(row: Record<string, unknown>): string[] {
  const rc = row.research_context as Record<string, unknown> | null;
  const raw = rc?.featuring_tracks;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return [];
}

export function buildPersonalizedIgDm(
  row: Record<string, unknown>,
  pitchTrackName: string,
  streamLink: string,
  engagementType: "thank_you" | "cross_pitch" | "thank_and_pitch",
): string {
  const curator = (row.curator_name as string | null)?.trim() || "there";
  const playlist = (row.playlist_name as string | null)?.trim() || "your playlist";
  const seed = String(row.playlist_id ?? playlist);
  const featured = featuringTracks(row);
  const featuredLabel = featured[0] && !featured[0].startsWith("(") ? featured[0] : "my music";

  const thankLine = `${hashPick(seed, OPENERS_THANK)} *${playlist}* — "${featuredLabel}" means a lot.`;
  const pitchLine = `${hashPick(seed + "p", OPENERS_PITCH)} *${playlist}*, I wanted to share *${pitchTrackName}*.`;
  const closer = hashPick(seed + "c", CLOSERS);

  const lines = [`Hi ${curator},`, ""];
  if (engagementType === "thank_you" || engagementType === "thank_and_pitch") {
    lines.push(thankLine, "");
  }
  if (engagementType === "cross_pitch" || engagementType === "thank_and_pitch") {
    lines.push(pitchLine, "");
    if (streamLink) lines.push(`Stream: ${streamLink}`, "");
  }
  lines.push(closer, "", "— Fendi Frost");
  return lines.join("\n");
}

export async function countIgDmsToday(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("social_engagement_queue")
    .select("*", { count: "exact", head: true })
    .eq("platform", "instagram")
    .eq("action", "pitch_dm")
    .in("status", ["pending", "sent"])
    .gte("created_at", start.toISOString());
  return count ?? 0;
}

export async function countIgDmsSentToday(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await sb.from("social_engagement_queue")
    .select("*", { count: "exact", head: true })
    .eq("platform", "instagram")
    .eq("status", "sent")
    .gte("performed_at", start.toISOString());
  return count ?? 0;
}

export async function queueIgDm(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  draftText: string,
  meta: Record<string, unknown>,
): Promise<boolean> {
  const playlistId = String(row.playlist_id ?? "");
  const handle = ((row.curator_submission_dm as string) || (row.curator_instagram as string) || "").replace(/^@/, "").trim();
  if (!handle || !isValidCuratorIgHandle(handle)) return false;

  const { data: existing } = await sb.from("social_engagement_queue")
    .select("id")
    .eq("playlist_id", playlistId)
    .eq("platform", "instagram")
    .in("status", ["pending", "sent"])
    .limit(1)
    .maybeSingle();
  if (existing?.id) return false;

  const { error } = await sb.from("social_engagement_queue").insert({
    platform: "instagram",
    action: "pitch_dm",
    target_url: `https://www.instagram.com/${handle}/`,
    draft_text: draftText,
    playlist_id: playlistId,
    status: "pending",
    result: meta,
  });
  return !error;
}

export async function runQueueIgOutreachBatch(
  sb: SupabaseClient,
  body: Record<string, unknown>,
  resolveStreamLink: (trackName: string) => Promise<string>,
  rowDiscoveryReferences: (row: Record<string, unknown>, lanes: Record<string, unknown>, refs: string[]) => string[],
): Promise<{ status: number; data: Record<string, unknown> }> {
  const trackName = String(body.track_name ?? "").trim();
  const lane = String(body.lane ?? "").trim();
  const engagementType = String(body.engagement_type ?? "thank_and_pitch") as
    "thank_you" | "cross_pitch" | "thank_and_pitch";
  const limit = Math.min(IG_DM_DAILY_CAP, Math.max(1, Number(body.limit) || IG_DM_DAILY_CAP));
  const placementOnly = Boolean(body.placement_only ?? true);
  const bodyRefs = Array.isArray(body.references) ? body.references.map(String) : [];

  if (!trackName) return { status: 400, data: { error: "track_name required" } };

  const sentToday = await countIgDmsSentToday(sb);
  const queuedToday = await countIgDmsToday(sb);
  const remaining = Math.max(0, IG_DM_DAILY_CAP - queuedToday);
  if (remaining <= 0) {
    return {
      status: 429,
      data: {
        error: `IG DM daily cap reached (${IG_DM_DAILY_CAP}/day UTC). Mark sent items or wait until tomorrow.`,
        cap: IG_DM_DAILY_CAP,
        queued_today: queuedToday,
        sent_today: sentToday,
      },
    };
  }

  const batchSize = Math.min(limit, remaining);
  let q = sb.from("playlist_targets")
    .select("*")
    .eq("is_active", true)
    .not("curator_instagram", "is", null)
    .neq("pitch_status", "disclaim_brand")
    .order("follower_count", { ascending: false, nullsFirst: false })
    .limit(80);

  if (lane) q = q.eq("lane", lane);
  if (placementOnly) {
    q = q.filter("research_context->>source", "eq", "spotify_placement");
  }

  const { data: rows, error } = await q;
  if (error) return { status: 500, data: { error: error.message } };

  const lanes = await loadLanesConfig(sb);
  const streamLink = await resolveStreamLink(trackName);
  const queued: string[] = [];
  const skipped: Record<string, string> = {};

  for (const row of rows ?? []) {
    if (queued.length >= batchSize) break;
    const rawIg = (row.curator_submission_dm as string) || (row.curator_instagram as string) || "";
    const handle = sanitizeCuratorIgHandle(rawIg.replace(/^@/, ""));
    if (!handle) {
      skipped[row.playlist_id] = "invalid_ig";
      continue;
    }
    const refs = rowDiscoveryReferences(row, lanes, bodyRefs);
    if (isArtistIgHandle(handle, refs)) {
      skipped[row.playlist_id] = "artist_ig";
      continue;
    }
    const draftText = buildPersonalizedIgDm(row, trackName, streamLink, engagementType);
    const ok = await queueIgDm(sb, row, draftText, {
      lane: row.lane,
      engagement_type: engagementType,
      pitch_track: trackName,
      featuring: featuringTracks(row),
      variant_seed: row.playlist_id,
      source: "queue_ig_outreach_batch",
    });
    if (ok) queued.push(row.playlist_id);
    else skipped[row.playlist_id] = "duplicate_or_failed";
  }

  return {
    status: 200,
    data: {
      ok: true,
      queued: queued.length,
      playlist_ids: queued,
      skipped,
      cap: IG_DM_DAILY_CAP,
      remaining_today: Math.max(0, IG_DM_DAILY_CAP - queuedToday - queued.length),
      engagement_type: engagementType,
    },
  };
}
