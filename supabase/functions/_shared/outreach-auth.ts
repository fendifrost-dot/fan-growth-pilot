// Single authorization layer for control-center-api.
//
// Every action is classified exactly once and mapped to an OpsCapability
// (or a public / authenticated-read class). The dispatcher consults this
// module before routing, so a new action cannot silently ship unauthenticated
// or with unrestricted machine admin-write access.
//
// Preferred pattern: ACTION → required OpsCapability → resolveOpsActor → can().
// There is no broad machineWriteAllowed() door. Claude / Grok / scheduler /
// service may only perform actions their capability matrix grants.
//
// Unknown actions fail closed. Public capture stays on an explicit allowlist.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  type OpsActor,
  type OpsCapability,
  can,
  isClaudeCredential,
  isClaudePlaylistDiscoveryCredential,
  isClaudeSyncDiscoveryCredential,
  isGrokCredential,
  isHubServiceCredential,
  isSchedulerCredential,
  resolveOpsActor,
} from './ops-actors.ts';

export type AuthClass =
  | 'public-read'
  | 'authenticated-read'
  | 'admin-write'
  | 'outreach-write'
  | 'internal-scheduler'
  | 'webhook'
  | 'capability';

export type Actor =
  | { kind: 'user'; userId: string; isAdmin: boolean }
  | { kind: 'scheduler' }
  | { kind: 'service' }
  | { kind: 'claude' }
  | { kind: 'claude_playlist_discovery' }
  | { kind: 'claude_sync_discovery' }
  | { kind: 'grok_playlist_control' }
  | { kind: 'anonymous' };

export type AuthDecision =
  | {
    ok: true;
    actor: Actor;
    cls: Exclude<AuthClass, 'capability'>;
    opsActor: OpsActor;
    capability: OpsCapability | null;
  }
  | { ok: false; status: number; error: string; cls: Exclude<AuthClass, 'capability'> | 'unknown' };

type ActionSpec =
  | { cls: 'public-read' }
  | { cls: 'authenticated-read' }
  | { cls: 'internal-scheduler'; capability?: OpsCapability }
  | { cls: 'webhook' }
  | { cls: 'capability'; capability: OpsCapability; surface: 'admin-write' | 'outreach-write' };

/**
 * Canonical action → authorization spec.
 * Discovery / research / draft actions Claude needs are capability-gated here
 * (not blanket-denied as legacy Phase-3 writes).
 */
export const ACTION_SPEC: Record<string, ActionSpec> = {
  // ---- Public catalog / campaign reads ------------------------------------
  list_campaigns: { cls: 'public-read' },
  get_campaign: { cls: 'public-read' },
  validate_campaign: { cls: 'public-read' },
  get_campaign_stats: { cls: 'public-read' },
  get_campaign_supply: { cls: 'public-read' },
  get_campaign_activity: { cls: 'public-read' },
  list_targets: { cls: 'public-read' },
  count_targets: { cls: 'public-read' },
  list_categories: { cls: 'public-read' },
  list_lanes: { cls: 'public-read' },

  // ---- Authenticated operator reads ---------------------------------------
  get_leads: { cls: 'capability', capability: 'manage_fan_engagement', surface: 'admin-write' },
  list_fan_roster: { cls: 'capability', capability: 'manage_fan_engagement', surface: 'admin-write' },
  get_fan_stats: { cls: 'capability', capability: 'manage_fan_engagement', surface: 'admin-write' },
  list_fan_dm_queue: { cls: 'capability', capability: 'manage_fan_engagement', surface: 'admin-write' },
  list_ig_roster: { cls: 'capability', capability: 'manage_fan_engagement', surface: 'admin-write' },
  get_radio_targets: { cls: 'capability', capability: 'manage_radio', surface: 'admin-write' },
  get_radio_pitch_log: { cls: 'capability', capability: 'manage_radio', surface: 'admin-write' },
  list_music_supervisors: { cls: 'capability', capability: 'manage_sync_registers', surface: 'admin-write' },
  list_licensing_pitches: { cls: 'capability', capability: 'manage_sync_registers', surface: 'admin-write' },
  list_drafts: { cls: 'capability', capability: 'read_playlist_ops', surface: 'outreach-write' },
  list_pitches: { cls: 'capability', capability: 'read_playlist_ops', surface: 'outreach-write' },
  get_pitch_log: { cls: 'capability', capability: 'read_playlist_ops', surface: 'outreach-write' },
  pitch_stats_summary: { cls: 'capability', capability: 'read_ops_metrics', surface: 'outreach-write' },
  list_discovery_profiles: { cls: 'capability', capability: 'read_playlist_discovery_work', surface: 'outreach-write' },
  get_discovery_capacity_plan: { cls: 'capability', capability: 'read_playlist_discovery_work', surface: 'outreach-write' },
  list_song_dna: { cls: 'capability', capability: 'draft_song_dna', surface: 'outreach-write' },
  get_song_dna: { cls: 'capability', capability: 'draft_song_dna', surface: 'outreach-write' },
  list_song_dna_audit: { cls: 'capability', capability: 'approve_song_dna', surface: 'admin-write' },

  // Remaining authenticated operator reads — JWT humans only for free reads;
  // machines must use explicit capability actions above or fail closed below.
  list_unverified_targets: { cls: 'authenticated-read' },
  list_warm_curators: { cls: 'authenticated-read' },
  recommend_targets_for_track: { cls: 'authenticated-read' },
  list_tracks: { cls: 'authenticated-read' },
  list_pitch_templates: { cls: 'authenticated-read' },
  preview_pitch_template: { cls: 'authenticated-read' },
  outreach_cutover_readiness: { cls: 'authenticated-read' },
  get_lyric_decoder_status: { cls: 'authenticated-read' },
  list_social_queue: { cls: 'authenticated-read' },
  get_momentum_alerts: { cls: 'authenticated-read' },
  get_marketing_actions: { cls: 'authenticated-read' },
  get_platform_metrics: { cls: 'authenticated-read' },
  get_outreach_stats: { cls: 'authenticated-read' },
  get_instagram_messaging_status: { cls: 'authenticated-read' },
  connect_spotify_status: { cls: 'authenticated-read' },

  // ---- Campaign lifecycle (human/Fendi only via manage_campaigns) ---------
  create_campaign_draft: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  update_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  activate_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  pause_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  resume_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  end_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  set_outreach_ceiling: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  // Pitch-campaign module aliases
  create_campaign: { cls: 'capability', capability: 'manage_campaigns', surface: 'admin-write' },
  check_campaign_config: { cls: 'authenticated-read' },
  list_campaignable_tracks: { cls: 'authenticated-read' },

  // ---- Playlist discovery / research (Claude authorized) ------------------
  run_playlist_research: {
    cls: 'capability',
    capability: 'research_playlist_targets',
    surface: 'outreach-write',
  },
  run_playlist_sweep: {
    cls: 'capability',
    capability: 'research_playlist_targets',
    surface: 'outreach-write',
  },
  reconcile_lane_targets: {
    cls: 'capability',
    capability: 'research_playlist_targets',
    surface: 'outreach-write',
  },
  discover_spotify_placements: {
    cls: 'capability',
    capability: 'run_placement_discovery',
    surface: 'outreach-write',
  },
  import_spotify_for_artists_csv: {
    cls: 'capability',
    capability: 'run_placement_discovery',
    surface: 'outreach-write',
  },
  enrich_curator_contacts: {
    cls: 'capability',
    capability: 'research_playlist_targets',
    surface: 'outreach-write',
  },
  enrich_radio_contacts: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'admin-write',
  },
  verify_targets: {
    cls: 'capability',
    capability: 'verify_playlist_targets',
    surface: 'outreach-write',
  },
  set_playlist_categories: {
    cls: 'capability',
    capability: 'record_research_evidence',
    surface: 'outreach-write',
  },
  set_track_categories: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },

  // ---- Draft / approve / send ---------------------------------------------
  draft_pitch: {
    cls: 'capability',
    capability: 'generate_playlist_drafts',
    surface: 'outreach-write',
  },
  approve_draft: {
    cls: 'capability',
    capability: 'approve_playlist_drafts',
    surface: 'outreach-write',
  },
  update_draft: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  delete_draft: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  invalidate_stale_drafts: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'admin-write',
  },
  audit_invalid_drafts: {
    cls: 'capability',
    capability: 'read_playlist_ops',
    surface: 'admin-write',
  },
  log_pitch_sent: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },
  log_platform_pitch: {
    cls: 'capability',
    capability: 'record_placement_evidence',
    surface: 'outreach-write',
  },
  schedule_follow_up: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  mark_pitch_response: {
    cls: 'capability',
    capability: 'classify_replies',
    surface: 'outreach-write',
  },
  mark_licensing_response: {
    cls: 'capability',
    capability: 'manage_sync_registers',
    surface: 'outreach-write',
  },
  send_campaign: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },
  send_telegram_campaign: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },
  queue_instagram_pitch: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  queue_ig_outreach_batch: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  mark_social_queue_sent: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },

  // ---- Target sendability -------------------------------------------------
  patch_target: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  activate_target: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  deactivate_target: {
    cls: 'capability',
    capability: 'write_playlist_ops',
    surface: 'outreach-write',
  },
  review_target: {
    cls: 'capability',
    capability: 'verify_playlist_targets',
    surface: 'outreach-write',
  },

  // ---- Song DNA -----------------------------------------------------------
  create_song_dna_draft: {
    cls: 'capability',
    capability: 'draft_song_dna',
    surface: 'admin-write',
  },
  update_song_dna_draft: {
    cls: 'capability',
    capability: 'draft_song_dna',
    surface: 'admin-write',
  },
  submit_song_dna_for_review: {
    cls: 'capability',
    capability: 'submit_song_dna_for_review',
    surface: 'admin-write',
  },
  approve_song_dna: {
    cls: 'capability',
    capability: 'approve_song_dna',
    surface: 'admin-write',
  },
  reject_song_dna: {
    cls: 'capability',
    capability: 'reject_song_dna',
    surface: 'admin-write',
  },
  upsert_discovery_profile: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  deactivate_discovery_profile: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  approve_discovery_profile: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  decode_track_lyrics: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },

  // ---- Smart links / catalog / imports ------------------------------------
  upsert_smart_link: {
    cls: 'capability',
    capability: 'manage_smart_links',
    surface: 'admin-write',
  },
  upsert_track: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  delete_track: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  upsert_music_supervisor: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  delete_music_supervisor: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  log_licensing_pitch: {
    cls: 'capability',
    capability: 'manage_sync_registers',
    surface: 'admin-write',
  },
  upsert_category: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  delete_category: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  upsert_lane: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  delete_lane: { cls: 'capability', capability: 'manage_catalog', surface: 'admin-write' },
  upsert_pitch_template: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  import_ig_roster: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'admin-write',
  },
  import_fan_roster: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'admin-write',
  },
  sync_ig_roster_from_targets: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'admin-write',
  },
  patch_ig_roster: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  patch_fan_roster: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  queue_fan_dm_batch: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  send_fan_dm_via_api: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  mark_fan_dm_sent: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  update_fan_dm_draft: {
    cls: 'capability',
    capability: 'manage_fan_engagement',
    surface: 'outreach-write',
  },
  backfill_sfa_placeholders: {
    cls: 'capability',
    capability: 'run_placement_discovery',
    surface: 'admin-write',
  },
  backfill_apple_station_baseline: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'admin-write',
  },
  connect_spotify_init: {
    cls: 'capability',
    capability: 'manage_catalog',
    surface: 'admin-write',
  },
  ingest_apple_spins: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'admin-write',
  },

  // ---- Radio --------------------------------------------------------------
  draft_radio_pitch: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'outreach-write',
  },
  send_radio_pitch: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'outreach-write',
  },
  patch_radio_target: {
    cls: 'capability',
    capability: 'manage_radio',
    surface: 'outreach-write',
  },

  // ---- Daily ops station ledger -------------------------------------------
  start_daily_station_run: {
    cls: 'capability',
    capability: 'run_daily_station',
    surface: 'outreach-write',
  },
  complete_daily_station_run: {
    cls: 'capability',
    capability: 'run_daily_station',
    surface: 'outreach-write',
  },
  list_daily_station_runs: {
    cls: 'capability',
    capability: 'read_daily_ops',
    surface: 'admin-write',
  },
  get_daily_station_run: {
    cls: 'capability',
    capability: 'run_daily_station',
    surface: 'admin-write',
  },
  get_daily_ops_dashboard: {
    cls: 'capability',
    capability: 'read_daily_ops',
    surface: 'admin-write',
  },
  list_ops_settings: {
    cls: 'capability',
    capability: 'read_daily_ops',
    surface: 'admin-write',
  },
  upsert_ops_setting: {
    cls: 'capability',
    capability: 'manage_ops_settings',
    surface: 'admin-write',
  },

  // ---- Grok handoff queues ------------------------------------------------
  create_handoff_batch: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'outreach-write',
  },
  add_handoff_records: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'outreach-write',
  },
  advance_handoff_batch: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'outreach-write',
  },
  advance_claude_ready_batches: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'outreach-write',
  },
  review_handoff_batch: {
    cls: 'capability',
    capability: 'review_handoff_batch',
    surface: 'outreach-write',
  },
  list_handoff_batches: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'admin-write',
  },
  get_handoff_batch: {
    cls: 'capability',
    capability: 'create_handoff_batch',
    surface: 'admin-write',
  },
  mark_manual_form_submitted: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },
  mark_manual_ig_dm_submitted: {
    cls: 'capability',
    capability: 'send_playlist_pitches',
    surface: 'outreach-write',
  },

  // ---- Multichannel path verification -------------------------------------
  verify_submission_path: {
    cls: 'capability',
    capability: 'verify_submission_path',
    surface: 'outreach-write',
  },
  build_web_form_packet: {
    cls: 'capability',
    capability: 'generate_playlist_drafts',
    surface: 'outreach-write',
  },
  build_instagram_dm_draft: {
    cls: 'capability',
    capability: 'generate_playlist_drafts',
    surface: 'outreach-write',
  },

  // ---- Claude sync research intake ----------------------------------------
  research_sync_targets: {
    cls: 'capability',
    capability: 'research_sync_targets',
    surface: 'outreach-write',
  },
  verify_sync_targets: {
    cls: 'capability',
    capability: 'verify_sync_targets',
    surface: 'outreach-write',
  },
  create_sync_target: {
    cls: 'capability',
    capability: 'create_sync_target',
    surface: 'outreach-write',
  },
  create_sync_opportunity: {
    cls: 'capability',
    capability: 'create_sync_opportunity',
    surface: 'outreach-write',
  },
  draft_sync_pitch: {
    cls: 'capability',
    capability: 'draft_sync_pitch',
    surface: 'outreach-write',
  },
  read_own_sync_batches: {
    cls: 'capability',
    capability: 'read_own_sync_batches',
    surface: 'outreach-write',
  },
  list_sync_research_targets: {
    cls: 'capability',
    capability: 'read_own_sync_batches',
    surface: 'admin-write',
  },
  list_sync_research_opportunities: {
    cls: 'capability',
    capability: 'read_own_sync_batches',
    surface: 'admin-write',
  },
  get_sync_discovery_work: {
    cls: 'capability',
    capability: 'read_sync_discovery_work',
    surface: 'outreach-write',
  },
  submit_sync_research: {
    cls: 'capability',
    capability: 'submit_sync_research',
    surface: 'outreach-write',
  },
  advance_sync_batch: {
    cls: 'capability',
    capability: 'advance_sync_batch',
    surface: 'outreach-write',
  },
  // ---- Grok sync control (extends grok_playlist_control) -------------------
  review_sync_outreach: {
    cls: 'capability',
    capability: 'review_sync_outreach',
    surface: 'outreach-write',
  },
  approve_sync_outreach: {
    cls: 'capability',
    capability: 'approve_sync_outreach',
    surface: 'outreach-write',
  },
  reject_sync_outreach: {
    cls: 'capability',
    capability: 'reject_sync_outreach',
    surface: 'outreach-write',
  },
  submit_sync_outreach: {
    cls: 'capability',
    capability: 'submit_sync_outreach',
    surface: 'outreach-write',
  },
  track_sync_responses: {
    cls: 'capability',
    capability: 'track_sync_responses',
    surface: 'outreach-write',
  },
  escalate_sync_to_fendi: {
    cls: 'capability',
    capability: 'escalate_sync_to_fendi',
    surface: 'outreach-write',
  },
  list_sync_pending_drafts: {
    cls: 'capability',
    capability: 'review_sync_outreach',
    surface: 'outreach-write',
  },
  // ---- Fendi-only sync gate approvals -------------------------------------
  get_sync_eligibility: { cls: 'authenticated-read' },
  approve_sample_declaration: {
    cls: 'capability',
    capability: 'approve_sample_declaration',
    surface: 'admin-write',
  },
  approve_sync_eligibility: {
    cls: 'capability',
    capability: 'approve_sync_eligibility',
    surface: 'admin-write',
  },
  recompute_sync_eligibility: {
    cls: 'capability',
    capability: 'approve_sync_eligibility',
    surface: 'admin-write',
  },
  update_sync_gate_ops_flags: {
    cls: 'capability',
    capability: 'update_sync_gate_ops_flags',
    surface: 'admin-write',
  },

  // ---- Authoritative split sheets / rights delivery -----------------------
  list_split_sheets: {
    cls: 'capability',
    capability: 'read_split_sheets',
    surface: 'admin-write',
  },
  get_split_sheet: {
    cls: 'capability',
    capability: 'read_split_sheets',
    surface: 'admin-write',
  },
  create_split_sheet_version: {
    cls: 'capability',
    capability: 'draft_split_sheet',
    surface: 'admin-write',
  },
  create_split_sheet: {
    cls: 'capability',
    capability: 'draft_split_sheet',
    surface: 'admin-write',
  },
  regenerate_split_sheet_document: {
    cls: 'capability',
    capability: 'draft_split_sheet',
    surface: 'admin-write',
  },
  record_contributor_confirmation: {
    cls: 'capability',
    capability: 'manage_split_sheet_evidence',
    surface: 'admin-write',
  },
  upload_split_sheet_evidence: {
    cls: 'capability',
    capability: 'manage_split_sheet_evidence',
    surface: 'admin-write',
  },
  mark_split_sheet_disputed: {
    cls: 'capability',
    capability: 'manage_split_sheet_evidence',
    surface: 'admin-write',
  },
  submit_split_sheet_for_fendi_review: {
    cls: 'capability',
    capability: 'draft_split_sheet',
    surface: 'admin-write',
  },
  finalize_split_sheet: {
    cls: 'capability',
    capability: 'finalize_split_sheet',
    surface: 'admin-write',
  },
  get_split_sheet_signed_url: {
    cls: 'capability',
    capability: 'download_split_sheet_document',
    surface: 'admin-write',
  },
  get_track_split_readiness: {
    cls: 'capability',
    capability: 'read_split_sheets',
    surface: 'admin-write',
  },
  get_split_sheet_delivery_availability: {
    cls: 'capability',
    capability: 'read_split_sheet_deliveries',
    surface: 'outreach-write',
  },
  request_split_sheet_delivery_authorization: {
    cls: 'capability',
    capability: 'request_split_sheet_delivery_authorization',
    surface: 'outreach-write',
  },
  grant_split_sheet_delivery_authorization: {
    cls: 'capability',
    capability: 'authorize_split_sheet_delivery',
    surface: 'admin-write',
  },
  deliver_split_sheet_to_sync_contact: {
    cls: 'capability',
    capability: 'deliver_split_sheet',
    surface: 'outreach-write',
  },
  list_split_sheet_deliveries: {
    cls: 'capability',
    capability: 'read_split_sheet_deliveries',
    surface: 'outreach-write',
  },
  record_split_sheet_delivery_response: {
    cls: 'capability',
    capability: 'deliver_split_sheet',
    surface: 'outreach-write',
  },
  // Deprecated destructive in-place edit — capability-gated; handler returns 410.
  update_split_sheet_contributors: {
    cls: 'capability',
    capability: 'draft_split_sheet',
    surface: 'admin-write',
  },
};

/**
 * Explicit public-action allowlist for unauthenticated smart-link / capture flows.
 * Anything else requires credentials. Keep this narrow.
 */
export const PUBLIC_ACTION_ALLOWLIST = new Set<string>([
  'list_categories',
  'list_lanes',
  'list_campaigns',
  'get_campaign',
  'validate_campaign',
  'get_campaign_stats',
  'get_campaign_supply',
  'get_campaign_activity',
  'list_targets',
  'count_targets',
]);

/**
 * Backward-compatible ACTION_AUTH class map derived from ACTION_SPEC.
 * Surfaces map capability actions onto admin-write / outreach-write for callers
 * that still inspect class labels.
 */
export const ACTION_AUTH: Record<string, AuthClass> = Object.fromEntries(
  Object.entries(ACTION_SPEC).map(([action, spec]) => {
    if (spec.cls === 'capability') return [action, spec.surface];
    return [action, spec.cls];
  }),
);

/**
 * Former Phase-3 write list — retained for tests/docs. These actions are now
 * capability-gated in ACTION_SPEC (not blanket-denied). Empty of "still open"
 * debt: every former entry must appear in ACTION_SPEC.
 */
export const PHASE_3_PENDING_WRITES: readonly string[] = [];

/** Required capability for an action, if any. */
export function requiredCapabilityForAction(action: string): OpsCapability | null {
  const spec = ACTION_SPEC[action];
  if (!spec) return null;
  if (spec.cls === 'capability') return spec.capability;
  if (spec.cls === 'internal-scheduler') return spec.capability ?? null;
  return null;
}

/** Unknown actions are denied, not defaulted to public. */
export function classifyAction(action: string): AuthClass | 'unknown' {
  const spec = ACTION_SPEC[action];
  if (!spec) return 'unknown';
  if (spec.cls === 'capability') return spec.surface;
  return spec.cls;
}

// ---------------------------------------------------------------------------
// Credential extraction
// ---------------------------------------------------------------------------

function bearerToken(req: Request): string {
  return (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

export function isSchedulerRequest(req: Request): boolean {
  return isSchedulerCredential(req);
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

/**
 * Resolve a credential-backed Actor from the request (secrets only).
 * Agent headers are never consulted here.
 */
export function resolveCredentialActor(req: Request): Actor | null {
  if (isSchedulerCredential(req)) return { kind: 'scheduler' };
  if (isGrokCredential(req)) return { kind: 'grok_playlist_control' };
  if (isClaudeSyncDiscoveryCredential(req)) return { kind: 'claude_sync_discovery' };
  if (isClaudePlaylistDiscoveryCredential(req)) return { kind: 'claude_playlist_discovery' };
  if (isClaudeCredential(req)) return { kind: 'claude' };
  if (isHubServiceCredential(req)) return { kind: 'service' };
  return null;
}

function artistUserId(): string {
  return (Deno.env.get('ARTIST_USER_ID') || Deno.env.get('FENDI_USER_ID') || '').trim();
}

async function resolveRequestActor(
  req: Request,
  sb: SupabaseClient,
): Promise<Actor | null> {
  const cred = resolveCredentialActor(req);
  if (cred) return cred;

  const user = await resolveUser(req, sb);
  if (!user) return null;

  const fendiId = artistUserId();
  if (fendiId && user.userId === fendiId) {
    return { kind: 'user', userId: user.userId, isAdmin: user.isAdmin || true };
  }
  if (!user.isAdmin) {
    return { kind: 'user', userId: user.userId, isAdmin: false };
  }
  return { kind: 'user', userId: user.userId, isAdmin: true };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export async function authorizeAction(
  action: string,
  req: Request,
  sb: SupabaseClient,
): Promise<AuthDecision> {
  const spec = ACTION_SPEC[action];
  if (!spec) {
    return {
      ok: false,
      status: 403,
      error: `Unknown action: ${action}`,
      cls: 'unknown',
    };
  }

  // Public reads only when explicitly allowlisted.
  if (spec.cls === 'public-read') {
    if (!PUBLIC_ACTION_ALLOWLIST.has(action)) {
      return { ok: false, status: 401, error: 'Authentication required', cls: 'public-read' };
    }
    const opsActor = resolveOpsActor({ kind: 'anonymous' }, req);
    return {
      ok: true,
      actor: { kind: 'anonymous' },
      cls: 'public-read',
      opsActor,
      capability: null,
    };
  }

  if (spec.cls === 'webhook') {
    return {
      ok: false,
      status: 403,
      error: `Action "${action}" must be verified by its provider webhook secret`,
      cls: 'webhook',
    };
  }

  if (spec.cls === 'internal-scheduler') {
    const cred = resolveCredentialActor(req);
    if (cred?.kind !== 'scheduler') {
      return {
        ok: false,
        status: 401,
        error: 'Scheduler credential required',
        cls: 'internal-scheduler',
      };
    }
    const opsActor = resolveOpsActor(cred, req);
    if (spec.capability && !can(opsActor, spec.capability)) {
      return {
        ok: false,
        status: 403,
        error: `${opsActor.label} is not permitted to ${spec.capability}`,
        cls: 'internal-scheduler',
      };
    }
    return {
      ok: true,
      actor: cred,
      cls: 'internal-scheduler',
      opsActor,
      capability: spec.capability ?? null,
    };
  }

  // Authenticated read or capability-gated write: resolve actor first.
  const actor = await resolveRequestActor(req, sb);
  const failCls: Exclude<AuthClass, 'capability'> =
    spec.cls === 'authenticated-read'
      ? 'authenticated-read'
      : spec.cls === 'capability'
      ? spec.surface
      : 'admin-write';

  if (!actor) {
    return {
      ok: false,
      status: 401,
      error: 'Sign-in or agent credential required',
      cls: failCls,
    };
  }

  // Non-admin ordinary users cannot reach operator surfaces.
  if (actor.kind === 'user' && !actor.isAdmin) {
    const fendiId = artistUserId();
    if (!(fendiId && actor.userId === fendiId)) {
      return {
        ok: false,
        status: 403,
        error: 'Admin role required for this action',
        cls: failCls,
      };
    }
  }

  const opsActor = resolveOpsActor(actor, req);

  if (spec.cls === 'authenticated-read') {
    if (opsActor.kind === 'anonymous') {
      return {
        ok: false,
        status: 401,
        error: 'Authentication required',
        cls: 'authenticated-read',
      };
    }
    // Machine credentials do not inherit every authenticated-read — JWT humans only.
    // Explicit capability-gated actions cover required agent projections.
    const machineKinds = new Set([
      'claude',
      'claude_playlist_discovery',
      'claude_sync_discovery',
      'grok_playlist_control',
      'service',
      'scheduler',
    ]);
    if (machineKinds.has(opsActor.kind)) {
      return {
        ok: false,
        status: 403,
        error:
          `${opsActor.label} cannot use open authenticated-read action "${action}" — use an explicit capability-gated projection`,
        cls: 'authenticated-read',
      };
    }
    return {
      ok: true,
      actor,
      cls: 'authenticated-read',
      opsActor,
      capability: null,
    };
  }

  // Capability-gated mutation — the only write path for machines and humans.
  if (spec.cls === 'capability') {
    if (!can(opsActor, spec.capability)) {
      return {
        ok: false,
        status: 403,
        error: `${opsActor.label} is not permitted to ${spec.capability}`,
        cls: spec.surface,
      };
    }
    return {
      ok: true,
      actor,
      cls: spec.surface,
      opsActor,
      capability: spec.capability,
    };
  }

  return {
    ok: false,
    status: 403,
    error: `Action "${action}" is not authorized`,
    cls: 'unknown',
  };
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
