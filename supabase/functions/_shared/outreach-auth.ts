// Single authorization layer for control-center-api.
//
// Every action is classified exactly once, here. The dispatcher consults this
// module before routing, so a new action cannot silently ship unauthenticated:
// anything absent from ACTION_AUTH is DENIED by default (see classifyAction).
//
// Classes
//   public-read        reads that stay open for now (list_*/get_*/count_*)
//   authenticated-read reads requiring a signed-in user
//   admin-write        human-only writes; admin JWT ONLY
//   outreach-write     writes that trigger/alter outreach; admin JWT OR the
//                      scheduler secret (the daily submissions task runs here)
//   internal-scheduler scheduler secret ONLY
//   webhook            verified by its own per-provider secret, not this layer
//
// The scheduler authenticates with its OWN secret (OUTREACH_SCHEDULER_SECRET),
// never by impersonating a frontend admin. That keeps the audit trail honest
// and lets the secret be rotated without touching anyone's login.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type AuthClass =
  | 'public-read'
  | 'authenticated-read'
  | 'admin-write'
  | 'outreach-write'
  | 'internal-scheduler'
  | 'webhook';

export type Actor =
  | { kind: 'user'; userId: string; isAdmin: boolean }
  | { kind: 'scheduler' }
  | { kind: 'service' }
  | { kind: 'anonymous' };

export type AuthDecision =
  | { ok: true; actor: Actor; cls: AuthClass }
  | { ok: false; status: number; error: string; cls: AuthClass | 'unknown' };

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * PHASE 1 SCOPE. Secured now: campaign lifecycle + everything that can trigger
 * or materially alter outreach. Deliberately NOT secured now: non-outreach
 * writes (upsert_track, categories, imports, research sweeps) — those are
 * Phase 3, listed in PHASE_3_PENDING_WRITES below so the debt is explicit
 * rather than forgotten.
 */
export const ACTION_AUTH: Record<string, AuthClass> = {
  // ---- Campaign lifecycle (human decisions; admin JWT only) ----------------
  create_campaign_draft: 'admin-write',
  update_campaign: 'admin-write',
  activate_campaign: 'admin-write',
  pause_campaign: 'admin-write',
  resume_campaign: 'admin-write',
  end_campaign: 'admin-write',
  set_outreach_ceiling: 'admin-write',

  // ---- Campaign reads -----------------------------------------------------
  list_campaigns: 'public-read',
  get_campaign: 'public-read',
  validate_campaign: 'public-read',
  get_campaign_stats: 'public-read',
  get_campaign_supply: 'public-read',
  get_campaign_activity: 'public-read',

  // ---- Outreach-triggering writes (admin JWT OR scheduler secret) ----------
  // These are what the daily submissions task drives. Locking them without
  // migrating that caller in the same release is what would break sending.
  draft_pitch: 'outreach-write',
  approve_draft: 'outreach-write',
  invalidate_stale_drafts: 'admin-write',
  update_draft: 'outreach-write',
  delete_draft: 'outreach-write',
  log_pitch_sent: 'outreach-write',
  log_platform_pitch: 'outreach-write',
  schedule_follow_up: 'outreach-write',
  mark_pitch_response: 'outreach-write',
  mark_licensing_response: 'outreach-write',
  send_campaign: 'outreach-write',
  send_telegram_campaign: 'outreach-write',
  queue_instagram_pitch: 'outreach-write',
  queue_ig_outreach_batch: 'outreach-write',
  mark_social_queue_sent: 'outreach-write',
  queue_fan_dm_batch: 'outreach-write',
  send_fan_dm_via_api: 'outreach-write',
  mark_fan_dm_sent: 'outreach-write',
  draft_radio_pitch: 'outreach-write',
  send_radio_pitch: 'outreach-write',

  // ---- Writes that change SENDABILITY (who/what may be contacted) ----------
  upsert_smart_link: 'admin-write',
  patch_target: 'outreach-write',
  activate_target: 'outreach-write',
  deactivate_target: 'outreach-write',
  review_target: 'outreach-write',
  verify_targets: 'outreach-write',
  patch_radio_target: 'outreach-write',
  patch_ig_roster: 'outreach-write',
  patch_fan_roster: 'outreach-write',

  // ---- Reads (stay public for now, per Phase 1 scope) ----------------------
  list_targets: 'public-read',
  count_targets: 'public-read',
  list_drafts: 'public-read',
  list_pitches: 'public-read',
  get_pitch_log: 'public-read',
  pitch_stats_summary: 'public-read',
  list_unverified_targets: 'public-read',
  list_warm_curators: 'public-read',
  recommend_targets_for_track: 'public-read',
  list_tracks: 'authenticated-read',
  list_music_supervisors: 'authenticated-read',
  list_licensing_pitches: 'authenticated-read',
  list_categories: 'authenticated-read',
  list_lanes: 'public-read',
  list_pitch_templates: 'public-read',
  preview_pitch_template: 'public-read',
  list_song_dna: 'public-read',
  get_song_dna: 'public-read',
  list_song_dna_audit: 'public-read',
  list_discovery_profiles: 'public-read',
  outreach_cutover_readiness: 'public-read',
  create_song_dna_draft: 'admin-write',
  update_song_dna_draft: 'admin-write',
  submit_song_dna_for_review: 'admin-write',
  approve_song_dna: 'admin-write',
  reject_song_dna: 'admin-write',
  upsert_discovery_profile: 'admin-write',
  deactivate_discovery_profile: 'admin-write',
  approve_discovery_profile: 'admin-write',
  get_lyric_decoder_status: 'public-read',
  decode_track_lyrics: 'admin-write',
  list_social_queue: 'public-read',
  list_ig_roster: 'public-read',
  list_fan_dm_queue: 'authenticated-read',
  list_fan_roster: 'authenticated-read',
  get_fan_stats: 'authenticated-read',
  get_leads: 'authenticated-read',
  get_momentum_alerts: 'public-read',
  get_marketing_actions: 'public-read',
  get_platform_metrics: 'public-read',
  get_radio_targets: 'public-read',
  get_radio_pitch_log: 'public-read',
  get_outreach_stats: 'public-read',
  get_instagram_messaging_status: 'public-read',
  connect_spotify_status: 'public-read',

  // ---- Lyrics / split sheets / ops / sync gate / press / coverage (AGH stack) ----
  list_lyrics: 'authenticated-read',
  get_lyrics: 'authenticated-read',
  upsert_lyrics_manual: 'admin-write',
  mark_lyrics_ready: 'admin-write',
  request_lyrics_provider_job: 'admin-write',
  list_split_sheets: 'authenticated-read',
  get_split_sheet: 'authenticated-read',
  create_split_sheet: 'admin-write',
  update_split_sheet_contributors: 'admin-write',
  regenerate_split_sheet_document: 'admin-write',
  list_ops_incidents: 'authenticated-read',
  log_ops_incident: 'admin-write',
  ack_ops_incident: 'admin-write',
  resolve_ops_incident: 'admin-write',
  list_press_kits: 'authenticated-read',
  upsert_press_kit: 'admin-write',
  list_private_licenses: 'authenticated-read',
  register_private_license: 'admin-write',
  get_track_sync_gate: 'authenticated-read',
  update_track_sync_gate: 'admin-write',
  recompute_track_sync_eligible: 'admin-write',
  audit_playlist_category_coverage: 'authenticated-read',
  list_playlist_ops_ledger: 'authenticated-read',
  get_playlist_ops_ledger: 'authenticated-read',
  get_ops_metrics: 'authenticated-read',
  get_playlist_ops_metrics: 'authenticated-read',
  upsert_playlist_ops_ledger: 'outreach-write',
  record_playlist_discovery: 'outreach-write',
  record_playlist_verification: 'outreach-write',
  record_playlist_draft: 'outreach-write',
  record_playlist_approval: 'outreach-write',
  record_playlist_draft_decision: 'outreach-write',
  record_playlist_send: 'outreach-write',
  record_inbox_check: 'outreach-write',
  record_reply_classification: 'outreach-write',
  record_curator_reply: 'outreach-write',
  record_response_draft: 'outreach-write',
  record_sent_response: 'outreach-write',
  record_placement_check: 'outreach-write',
  record_placement_evidence: 'outreach-write',
  open_playlist_ops_incident: 'outreach-write',

  // Close anonymous catalog / supervisor / licensing / category / research writes
  upsert_track: 'admin-write',
  delete_track: 'admin-write',
  upsert_music_supervisor: 'admin-write',
  delete_music_supervisor: 'admin-write',
  log_licensing_pitch: 'admin-write',
  upsert_category: 'admin-write',
  delete_category: 'admin-write',
  upsert_lane: 'admin-write',
  delete_lane: 'admin-write',
  upsert_pitch_template: 'admin-write',
  set_track_categories: 'admin-write',
  set_playlist_categories: 'admin-write',
  run_playlist_research: 'outreach-write',
  run_playlist_sweep: 'outreach-write',
  discover_spotify_placements: 'outreach-write',
};

/**
 * PHASE 3 — committed follow-on, not indefinite. Legacy WRITE actions that do
 * not trigger or alter outreach, so they are out of Phase 1's minimum scope but
 * remain unauthenticated until hardened. Listed explicitly so this is tracked
 * debt with a defined boundary.
 *
 * Judgment call worth reviewing: set_track_categories / set_playlist_categories
 * influence future target matching, but campaign configuration_snapshot freezes
 * genres at activation, so they cannot alter an in-flight campaign. On that
 * basis they sit in Phase 3 rather than Phase 1.
 */
export const PHASE_3_PENDING_WRITES = [
  // Catalog / supervisor / licensing / category / research writes moved to ACTION_AUTH.
  'ingest_apple_spins',
  'enrich_curator_contacts',
  'enrich_radio_contacts',
  'reconcile_lane_targets',
  'import_spotify_for_artists_csv',
  'import_ig_roster',
  'import_fan_roster',
  'sync_ig_roster_from_targets',
  'backfill_sfa_placeholders',
  'backfill_apple_station_baseline',
  'connect_spotify_init',
] as const;

const PHASE_3_SET = new Set<string>(PHASE_3_PENDING_WRITES);

/** Unknown actions are denied, not defaulted to public. */
export function classifyAction(action: string): AuthClass | 'phase3-legacy' | 'unknown' {
  if (ACTION_AUTH[action]) return ACTION_AUTH[action];
  if (PHASE_3_SET.has(action)) return 'phase3-legacy';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

function bearerToken(req: Request): string {
  return (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

function schedulerSecretPresented(req: Request): string {
  // Dedicated header so the scheduler credential is never confused with the
  // legacy hub key or a user JWT.
  return (req.headers.get('x-outreach-scheduler-secret') || '').trim();
}

/** Constant-time-ish compare to avoid leaking secret length/prefix by timing. */
function secretsMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isSchedulerRequest(req: Request): boolean {
  const expected = (Deno.env.get('OUTREACH_SCHEDULER_SECRET') || '').trim();
  return Boolean(expected) && secretsMatch(schedulerSecretPresented(req), expected);
}

async function resolveUser(
  req: Request,
  sb: SupabaseClient,
): Promise<{ userId: string; isAdmin: boolean } | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: role } = await sb
    .from('user_roles')
    .select('role')
    .eq('user_id', data.user.id)
    .eq('role', 'admin')
    .maybeSingle();

  return { userId: data.user.id, isAdmin: Boolean(role) };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function authorizeAction(
  action: string,
  req: Request,
  sb: SupabaseClient,
): Promise<AuthDecision> {
  const cls = classifyAction(action);

  if (cls === 'unknown') {
    return { ok: false, status: 400, error: `Unknown action: ${action}`, cls: 'unknown' };
  }

  // Phase 3 debt: still open, but explicitly acknowledged rather than
  // accidentally open because it fell through a default-allow branch.
  if (cls === 'phase3-legacy') {
    return { ok: true, actor: { kind: 'anonymous' }, cls: 'public-read' };
  }

  if (cls === 'public-read') {
    return { ok: true, actor: { kind: 'anonymous' }, cls };
  }

  const scheduler = isSchedulerRequest(req);

  if (cls === 'internal-scheduler') {
    return scheduler
      ? { ok: true, actor: { kind: 'scheduler' }, cls }
      : { ok: false, status: 401, error: 'Scheduler credential required', cls };
  }

  if (cls === 'outreach-write' && scheduler) {
    return { ok: true, actor: { kind: 'scheduler' }, cls };
  }

  const user = await resolveUser(req, sb);

  if (cls === 'authenticated-read') {
    return user
      ? { ok: true, actor: { kind: 'user', userId: user.userId, isAdmin: user.isAdmin }, cls }
      : { ok: false, status: 401, error: 'Sign-in required', cls };
  }

  // admin-write and outreach-write both require an admin user from here.
  if (!user) {
    return { ok: false, status: 401, error: 'Sign-in required for this action', cls };
  }
  if (!user.isAdmin) {
    return { ok: false, status: 403, error: 'Admin role required for this action', cls };
  }
  return { ok: true, actor: { kind: 'user', userId: user.userId, isAdmin: true }, cls };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function recordAudit(
  sb: SupabaseClient,
  entry: {
    campaignId?: string | null;
    eventType: string;
    actor: Actor;
    fromStatus?: string | null;
    toStatus?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const actorKind = entry.actor.kind === 'user'
    ? 'user'
    : entry.actor.kind === 'scheduler'
    ? 'scheduler'
    : 'service';

  // Audit must never break the operation it is recording.
  const { error } = await sb.from('campaign_audit_events').insert({
    campaign_id: entry.campaignId ?? null,
    event_type: entry.eventType,
    actor_user_id: entry.actor.kind === 'user' ? entry.actor.userId : null,
    actor_kind: actorKind,
    from_status: entry.fromStatus ?? null,
    to_status: entry.toStatus ?? null,
    detail: entry.detail ?? {},
  });
  if (error) console.error('audit write failed:', error.message);
}
