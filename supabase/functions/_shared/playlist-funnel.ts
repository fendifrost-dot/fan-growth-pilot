/**
 * Per-song daily funnel for the playlist pipeline (CT business date).
 *
 * The business goal is ACTUAL SUBMISSIONS per song (default 30). Drafts, reviews and
 * approvals are reported separately and never counted as submissions. A station run can
 * finish successfully while the business target is unmet — the two are reported apart.
 *
 * Units:
 *   raw candidate  = one distinct song–playlist candidate evaluated that day
 *                    (agh_playlist_candidate_evaluations; retries collapse)
 *   eligible packet = a handoff record created for the song (route + fit verified)
 *   submission      = email pitch_log row status=sent with a provider message id, or a
 *                     manual web-form / IG record with submitted_at (evidence recorded)
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { chicagoBusinessDate } from "./chicago-time.ts";
import { hostOf } from "./submission-route.ts";
import { buildDiscoveryCapacityPlan } from "./discovery-capacity.ts";

export type SongFunnel = {
  track_id: string;
  title: string | null;
  business_date_ct: string;
  // discovery
  raw_candidates_evaluated: number;
  net_new_identities: number;
  existing_playlists_newly_matched: number;
  duplicates_skipped: number;
  candidates_rejected: number;
  candidates_accepted_unverified: number;
  // packets
  verified_eligible_packets_today: number;
  drafts_awaiting_review: number;
  drafts_awaiting_review_today: number;
  oldest_pending_review_age_hours: number | null;
  reviewed_not_approved: number;
  approved_not_submitted: number;
  // outcomes
  submissions_today: number;
  submissions_email_today: number;
  submissions_manual_today: number;
  send_failures_today: number;
  rejected_by_grok: number;
  route_holds: number;
  hold_reasons: Record<string, number>;
  // target
  objective_submissions: number;
  business_target_met: boolean;
  submission_shortfall: number;
  remaining_eligible_packets_needed: number;
  /** Packets still needed today after stuck backlog is set aside. Same number as remaining_eligible_packets_needed. */
  discovery_headroom: number;
  usable_inflight_packets: number;
  capacity_exclusions: CapacityExclusions;
  raw_candidates_needed: number | null;
  raw_candidates_needed_basis: string;
};

/**
 * Records that must not fill a song's daily discovery goal. Soundplate stays
 * frozen; this only stops those packets, repair-parked packets, terminal
 * rows, unsent IG DMs, and contact-policy failures from looking like supply.
 */
export type CapacityExclusions = {
  soundplate: number;
  route_repair: number;
  rejected: number;
  sent: number;
  contact_policy: number;
  instagram_dm_unsent: number;
};

export const FROZEN_DISCOVERY_ROUTE_HOSTS = ["soundplate.com"] as const;

export function emptyCapacityExclusions(): CapacityExclusions {
  return {
    soundplate: 0,
    route_repair: 0,
    rejected: 0,
    sent: 0,
    contact_policy: 0,
    instagram_dm_unsent: 0,
  };
}

/** Soundplate (and any later frozen-route host) is not discovery supply. */
export function isFrozenDiscoveryRouteUrl(url: unknown): boolean {
  const host = hostOf(String(url ?? ""));
  if (!host) return false;
  return FROZEN_DISCOVERY_ROUTE_HOSTS.some((frozen) => host === frozen || host.endsWith(`.${frozen}`));
}

export function isSoundplateRecord(
  record: Record<string, unknown>,
  target?: Record<string, unknown> | null,
): boolean {
  const packet = (record.packet ?? null) as Record<string, unknown> | null;
  const urls = [
    target?.form_url,
    target?.submission_url,
    target?.curator_website,
    packet?.form_url,
    packet?.submission_url,
  ];
  if (urls.some((url) => isFrozenDiscoveryRouteUrl(url))) return true;
  const method = String(target?.submission_method ?? packet?.submission_method ?? "").toLowerCase();
  return method === "soundplate";
}

export function isRouteRepairBatch(batch: Record<string, unknown> | null | undefined): boolean {
  const payload = (batch?.payload ?? null) as Record<string, unknown> | null;
  return String(payload?.route_hold_repair ?? "") === "true";
}

export type FunnelResult = {
  ok: boolean;
  songs: SongFunnel[];
  errors: string[];
  evaluation_log_available: boolean;
};

const OPEN_REVIEW_STATES = new Set(["CLAUDE_BATCH_READY", "CLAUDE_PLAYLIST_COMPLETE", "AWAITING_GROK_REVIEW"]);

const INFLIGHT_STATES = new Set([...OPEN_REVIEW_STATES, "GROK_REVIEWED", "APPROVED_FOR_SEND", "AWAITING_AGH_IMPORT"]);

/** A defer without a valid retry time needs review; it is not available supply. */
export function usableInflightPacket(record: Record<string, unknown>, now: Date): boolean {
  if (record.submitted_at || !INFLIGHT_STATES.has(String(record.queue_state))) return false;
  const packet = record.packet as Record<string, unknown> | null;
  if (packet?.route_hold) return false;
  if (packet?.review_defer) {
    const defer = packet.review_defer as Record<string, unknown>;
    const retry = Date.parse(String(defer.retry_after ?? ""));
    if (!Number.isFinite(retry) || retry > now.getTime()) return false;
  }
  return true;
}

function isMissingRelation(msg: string): boolean {
  return /does not exist|could not find the table|PGRST205|42P01/i.test(msg);
}

/** Pure: remaining need and raw candidates required, with coherent units. */
export function computeRemainingNeed(opts: {
  objective: number;
  submissionsToday: number;
  approvedNotSubmitted: number;
  awaitingReviewToday: number;
  /** All usable unsent packets, including older and reviewed records. */
  usableInflightPackets?: number;
  rawToEligibleRate: number | null;
}): { shortfall: number; remainingPackets: number; rawNeeded: number | null; basis: string } {
  const shortfall = Math.max(0, opts.objective - opts.submissionsToday);
  // Usable inventory can come from any day and any pre-submission review stage.
  // This is a supply floor, not a guarantee that every packet will be submitted.
  const inflight = opts.usableInflightPackets ?? (opts.approvedNotSubmitted + opts.awaitingReviewToday);
  const remainingPackets = Math.max(0, shortfall - inflight);
  if (remainingPackets === 0) return { shortfall, remainingPackets, rawNeeded: 0, basis: "no_remaining_need" };
  if (opts.rawToEligibleRate == null) return { shortfall, remainingPackets, rawNeeded: null, basis: "no_yield_measurement" };
  if (opts.rawToEligibleRate <= 0) return { shortfall, remainingPackets, rawNeeded: null, basis: "measured_zero_yield" };
  return {
    shortfall,
    remainingPackets,
    rawNeeded: Math.ceil(remainingPackets / opts.rawToEligibleRate),
    basis: "measured_yield",
  };
}

export type DiscoveryAllocation = {
  track_id: string;
  title: string | null;
  remaining_eligible_packets_needed: number;
  raw_candidates_needed: number | null;
  packets_today_over_objective: number;
  share_of_remaining_need: number;
  priority_rank: number;
};

/**
 * Split further discovery by each song's OWN remaining need. One song's surplus never
 * offsets another's shortfall (DFM 42/30 drafts does nothing for Meditate 13/30); a song
 * with no remaining need gets share 0.
 */
export function allocateDiscovery(songs: Pick<SongFunnel,
  "track_id" | "title" | "remaining_eligible_packets_needed" | "raw_candidates_needed" | "verified_eligible_packets_today" | "objective_submissions"
>[]): DiscoveryAllocation[] {
  const total = songs.reduce((a, s) => a + s.remaining_eligible_packets_needed, 0);
  const ranked = [...songs].sort((a, b) => b.remaining_eligible_packets_needed - a.remaining_eligible_packets_needed);
  return ranked.map((s, i) => ({
    track_id: s.track_id,
    title: s.title,
    remaining_eligible_packets_needed: s.remaining_eligible_packets_needed,
    raw_candidates_needed: s.raw_candidates_needed,
    packets_today_over_objective: Math.max(0, s.verified_eligible_packets_today - s.objective_submissions),
    share_of_remaining_need: total > 0 ? Math.round((s.remaining_eligible_packets_needed / total) * 1000) / 1000 : 0,
    priority_rank: i + 1,
  }));
}

// Fetch every page; PostgREST otherwise silently caps the queue at 1,000 rows.
async function allPages(query: () => any): Promise<{data: Record<string, unknown>[]; error: any}> {
 const rows: Record<string, unknown>[] = [];
 for (let start=0;;start+=1000) {
  const result = await query().range(start,start+999);
  if (result.error) return {data:[],error:result.error};
  rows.push(...(result.data ?? []));
  if ((result.data ?? []).length < 1000) return {data:rows,error:null};
 }
}
export async function buildPerSongFunnel(
  sb: SupabaseClient,
  tracks: { track_id: string; title?: string | null }[],
  opts: { objectivePerSong: number; rawToEligibleRate: number | null; now?: Date },
): Promise<FunnelResult> {
  const now = opts.now ?? new Date();
  const today = chicagoBusinessDate(now);
  const ids = tracks.map((t) => t.track_id).filter(Boolean);
  const errors: string[] = [];
  if (!ids.length) return { ok: true, songs: [], errors, evaluation_log_available: true };
  const sinceIso = new Date(now.getTime() - 36 * 3600 * 1000).toISOString();
  const isToday = (iso: unknown) => !!iso && chicagoBusinessDate(new Date(String(iso))) === today;

  // Candidate evaluations (server-side raw denominator).
  let evalRows: Record<string, unknown>[] = [];
  let evalAvailable = true;
  {
    const { data, error } = await allPages(() => sb
      .from("agh_playlist_candidate_evaluations")
      .select("track_id, outcome, created_target, business_date_ct")
      .eq("business_date_ct", today)
      .in("track_id", ids).order("id"));
    if (error) {
      if (isMissingRelation(String(error.message))) evalAvailable = false;
      else errors.push(`candidate_evaluations_query_failed:${error.message}`);
    } else evalRows = (data ?? []) as Record<string, unknown>[];
  }

  // Handoff records (all open + today's).
  let recs: Record<string, unknown>[] = [];
  {
    const { data, error } = await allPages(() => sb
      .from("agh_handoff_records")
      .select("id, track_id, queue_state, submitted_at, manual_submit_result, created_at, packet, record_kind, playlist_target_id, submission_channel, batch_id")
      .in("track_id", ids).order("id"));
    if (error) errors.push(`handoff_records_query_failed:${error.message}`);
    else recs = ((data ?? []) as Record<string, unknown>[]).filter((r) => (r.record_kind ?? "playlist_target") === "playlist_target");
  }

  // Email sends with provider evidence (and failures) since yesterday.
  let sends: Record<string, unknown>[] = [];
  {
    const { data, error } = await allPages(() => sb
      .from("pitch_log")
      .select("track_id, status, sent_at, pitched_at, resend_message_id")
      .in("track_id", ids)
      .gte("pitched_at", sinceIso).order("id"));
    if (error) errors.push(`pitch_log_query_failed:${error.message}`);
    else sends = (data ?? []) as Record<string, unknown>[];
  }

  const targetById = new Map<string, Record<string, unknown>>();
  const batchById = new Map<string, Record<string, unknown>>();
  const targetIds = [...new Set(recs.map((r) => String(r.playlist_target_id ?? "")).filter(Boolean))];
  const batchIds = [...new Set(recs.map((r) => String(r.batch_id ?? "")).filter(Boolean))];
  for (let i = 0; i < targetIds.length; i += 200) {
    const slice = targetIds.slice(i, i + 200);
    const { data, error } = await allPages(() => sb
      .from("playlist_targets")
      .select("playlist_id, form_url, submission_url, submission_method, curator_website")
      .in("playlist_id", slice)
      .order("playlist_id"));
    if (error) {
      errors.push(`playlist_targets_query_failed:${error.message}`);
      break;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) targetById.set(String(row.playlist_id), row);
  }
  for (let i = 0; i < batchIds.length; i += 200) {
    const slice = batchIds.slice(i, i + 200);
    const { data, error } = await allPages(() => sb
      .from("agh_handoff_batches")
      .select("id, payload")
      .in("id", slice)
      .order("id"));
    if (error) {
      errors.push(`handoff_batches_query_failed:${error.message}`);
      break;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) batchById.set(String(row.id), row);
  }

  const policyCache = new Map<string, boolean>();
  let policyErrorNoted = false;
  const contactPolicyBlocks = async (record: Record<string, unknown>): Promise<boolean> => {
    const playlistId = String(record.playlist_target_id ?? "").trim();
    const trackId = String(record.track_id ?? "").trim();
    const channel = String(record.submission_channel ?? "email").trim() || "email";
    if (!playlistId || !trackId) return false;
    const key = `${playlistId}|${trackId}|${channel}`;
    const cached = policyCache.get(key);
    if (cached != null) return cached;
    if (typeof (sb as { rpc?: unknown }).rpc !== "function") {
      policyCache.set(key, false);
      return false;
    }
    const { data, error } = await sb.rpc("agh_contact_policy", {
      p_target: playlistId,
      p_track: trackId,
      p_channel: channel,
    });
    if (error) {
      if (!policyErrorNoted) {
        errors.push(`contact_policy_query_failed:${error.message}`);
        policyErrorNoted = true;
      }
      policyCache.set(key, true);
      return true;
    }
    const policy = data as { ok?: boolean } | null;
    const blocked = !policy || policy.ok !== true;
    policyCache.set(key, blocked);
    return blocked;
  };

  const songs: SongFunnel[] = [];
  for (const t of tracks) {
    const ev = evalRows.filter((r) => String(r.track_id) === t.track_id);
    const rs = recs.filter((r) => String(r.track_id) === t.track_id);
    const sl = sends.filter((r) => String(r.track_id) === t.track_id);

    const count = (pred: (r: Record<string, unknown>) => boolean, arr = rs) => arr.filter(pred).length;
    const pending = rs.filter((r) => OPEN_REVIEW_STATES.has(String(r.queue_state)) && !(r.packet as Record<string, unknown> | null)?.route_hold);
    const oldest = pending.reduce<number | null>((min, r) => {
      const ts = Date.parse(String(r.created_at ?? ""));
      if (!Number.isFinite(ts)) return min;
      return min == null || ts < min ? ts : min;
    }, null);
    const holdReasons: Record<string, number> = {};
    for (const r of rs) {
      const hold = (r.packet as Record<string, unknown> | null)?.route_hold as Record<string, unknown> | undefined;
      if (hold && !r.submitted_at) {
        const code = String(hold.code ?? "route_hold");
        holdReasons[code] = (holdReasons[code] ?? 0) + 1;
      }
    }

    // Bounced sends keep resend_message_id. Only status sent is a delivery.
    const emailSubmissions = count((r) => String(r.status).toLowerCase() === "sent" && !!r.resend_message_id && isToday(r.sent_at ?? r.pitched_at), sl);
    const manualSubmissions = count((r) => isToday(r.submitted_at) && !!(r.packet as Record<string, unknown> | null)?.submission_receipt);
    const submissions = emailSubmissions + manualSubmissions;
    const approvedNotSubmitted = count((r) =>
      (r.queue_state === "APPROVED_FOR_SEND" || r.queue_state === "AWAITING_AGH_IMPORT") && !r.submitted_at
    );
    const awaitingToday = pending.filter((r) => isToday(r.created_at)).length;

    const exclusions = emptyCapacityExclusions();
    const supply: Record<string, unknown>[] = [];
    for (const r of rs) {
      const state = String(r.queue_state ?? "");
      const target = targetById.get(String(r.playlist_target_id ?? "")) ?? null;
      const batch = batchById.get(String(r.batch_id ?? "")) ?? null;
      const repair = isRouteRepairBatch(batch);
      const soundplate = isSoundplateRecord(r, target);
      const rejected = state.startsWith("REJECTED_");
      const sent = state === "SENT";
      const igUnsent = String(r.submission_channel ?? "") === "instagram_dm" && !r.submitted_at;
      if (rejected) exclusions.rejected++;
      if (sent) exclusions.sent++;
      if (repair) exclusions.route_repair++;
      if (soundplate && !rejected && !sent) exclusions.soundplate++;
      if (!usableInflightPacket(r, now) || repair || soundplate || rejected || sent) continue;
      if (igUnsent) {
        exclusions.instagram_dm_unsent++;
        continue;
      }
      supply.push(r);
    }
    let usableInflight = 0;
    for (const r of supply) {
      if (await contactPolicyBlocks(r)) {
        exclusions.contact_policy++;
        continue;
      }
      usableInflight++;
    }
    const need = computeRemainingNeed({
      objective: opts.objectivePerSong,
      submissionsToday: submissions,
      approvedNotSubmitted,
      awaitingReviewToday: awaitingToday,
      usableInflightPackets: usableInflight,
      rawToEligibleRate: opts.rawToEligibleRate,
    });

    songs.push({
      track_id: t.track_id,
      title: t.title ?? null,
      business_date_ct: today,
      raw_candidates_evaluated: ev.length,
      net_new_identities: count((r) => r.created_target === true, ev),
      existing_playlists_newly_matched: count((r) => r.outcome === "verified_eligible_existing", ev),
      duplicates_skipped: count((r) => r.outcome === "duplicate", ev),
      candidates_rejected: count((r) => r.outcome === "rejected", ev),
      candidates_accepted_unverified: count((r) => r.outcome === "accepted_unverified", ev),
      verified_eligible_packets_today: count((r) => isToday(r.created_at)),
      drafts_awaiting_review: pending.length,
      drafts_awaiting_review_today: awaitingToday,
      oldest_pending_review_age_hours: oldest == null ? null : Math.round((now.getTime() - oldest) / 36e5 * 10) / 10,
      reviewed_not_approved: count((r) => r.queue_state === "GROK_REVIEWED"),
      approved_not_submitted: approvedNotSubmitted,
      submissions_today: submissions,
      submissions_email_today: emailSubmissions,
      submissions_manual_today: manualSubmissions,
      send_failures_today: count((r) => String(r.status) === "error" && isToday(r.pitched_at), sl),
      rejected_by_grok: count((r) => r.queue_state === "REJECTED_BY_GROK"),
      route_holds: Object.values(holdReasons).reduce((a, b) => a + b, 0),
      hold_reasons: holdReasons,
      objective_submissions: opts.objectivePerSong,
      business_target_met: submissions >= opts.objectivePerSong,
      submission_shortfall: need.shortfall,
      remaining_eligible_packets_needed: need.remainingPackets,
      discovery_headroom: need.remainingPackets,
      usable_inflight_packets: usableInflight,
      capacity_exclusions: exclusions,
      raw_candidates_needed: need.rawNeeded,
      raw_candidates_needed_basis: need.basis,
    });
  }

  return { ok: errors.length === 0, songs, errors, evaluation_log_available: evalAvailable };
}

/** Per-song discovery headroom for the Hub and for get_playlist_discovery_work. */
export async function buildPlaylistDiscoveryHeadroom(sb: SupabaseClient): Promise<{
  ok: boolean;
  error?: string;
  songs: Pick<SongFunnel,
    "track_id" | "title" | "discovery_headroom" | "objective_submissions" | "submissions_today" |
    "usable_inflight_packets" | "capacity_exclusions" | "raw_candidates_needed" | "remaining_eligible_packets_needed"
  >[];
  errors: string[];
}> {
  const { data: camps, error } = await sb.from("pitch_campaigns").select("track_id, status").eq("status", "active");
  if (error) return { ok: false, error: error.message, songs: [], errors: [`campaign_query_failed:${error.message}`] };
  const ids = [...new Set(((camps ?? []) as { track_id: string }[]).map((c) => String(c.track_id)).filter(Boolean))];
  const { data: trackRows, error: trackErr } = ids.length
    ? await sb.from("tracks").select("id, name").in("id", ids)
    : { data: [] as { id: string; name: string }[], error: null };
  if (trackErr) return { ok: false, error: trackErr.message, songs: [], errors: [`track_query_failed:${trackErr.message}`] };
  const names = new Map(((trackRows ?? []) as { id: string; name: string }[]).map((t) => [String(t.id), t.name]));
  const plan = await buildDiscoveryCapacityPlan(sb, ids.length);
  const r2v = plan.funnel.raw_to_verified;
  const funnel = await buildPerSongFunnel(
    sb,
    ids.map((id) => ({ track_id: id, title: names.get(id) ?? null })),
    { objectivePerSong: plan.target_verified_per_song_per_day, rawToEligibleRate: r2v.status === "measured" ? r2v.rate : null },
  );
  return {
    ok: funnel.ok,
    songs: funnel.songs.map((s) => ({
      track_id: s.track_id,
      title: s.title,
      discovery_headroom: s.discovery_headroom,
      remaining_eligible_packets_needed: s.remaining_eligible_packets_needed,
      objective_submissions: s.objective_submissions,
      submissions_today: s.submissions_today,
      usable_inflight_packets: s.usable_inflight_packets,
      capacity_exclusions: s.capacity_exclusions,
      raw_candidates_needed: s.raw_candidates_needed,
    })),
    errors: funnel.errors,
  };
}
