-- Daily station ledger, Grok handoff queues, multichannel playlist intake,
-- discovery capacity settings, and Claude sync-research intake.
--
-- CONTRACT FILE. Apply via Lovable SQL Editor (paste). Idempotent / additive.
-- Does NOT pause existing playlist email outreach.

begin;

-- ---------------------------------------------------------------------------
-- 0. playlist_ops_ledger (types already reference it; ensure version-controlled)
-- ---------------------------------------------------------------------------
create table if not exists public.playlist_ops_ledger (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  playlist_target_id text,
  campaign_id uuid,
  draft_id uuid,
  approved_song_dna_version_id uuid,
  discovery_date date,
  discovery_source text,
  discovered_by text,
  discovered_by_label text,
  discovered_at timestamptz,
  verification_result text,
  verified_by text,
  verified_by_label text,
  verified_at timestamptz,
  drafted_by text,
  drafted_by_label text,
  drafted_at timestamptz,
  approval_result text,
  approved_by text,
  approved_by_label text,
  approved_at timestamptz,
  sent_by text,
  sent_by_label text,
  sent_at timestamptz,
  send_result text,
  email_message_id text,
  email_thread_id text,
  response_status text,
  response_draft text,
  response_sent_at timestamptz,
  response_checked_by text,
  response_checked_by_label text,
  last_inbox_check_at timestamptz,
  next_response_check_at timestamptz,
  placement_status text,
  placement_evidence jsonb,
  placement_checked_by text,
  placement_checked_by_label text,
  last_placement_check_at timestamptz,
  next_placement_check_at timestamptz,
  rejection_or_shortfall_reason text,
  incident_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playlist_ops_ledger_track_idx
  on public.playlist_ops_ledger (track_id, created_at desc);

alter table public.playlist_ops_ledger enable row level security;

drop policy if exists playlist_ops_ledger_admin_all on public.playlist_ops_ledger;
create policy playlist_ops_ledger_admin_all on public.playlist_ops_ledger
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 1. Operational settings (editable floors — not code constants)
-- ---------------------------------------------------------------------------
create table if not exists public.ops_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  description text,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.ops_settings enable row level security;

drop policy if exists ops_settings_admin_all on public.ops_settings;
create policy ops_settings_admin_all on public.ops_settings
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

insert into public.ops_settings (setting_key, setting_value, description) values
  (
    'discovery_capacity',
    jsonb_build_object(
      'interim_raw_floor_per_song', 45,
      'interim_verified_floor_per_song', 30,
      'target_verified_per_song_per_day', 30,
      'trailing_conversion_lookback_days', 7,
      'min_conversion_rate', 0.05
    ),
    'Daily discovery planning floors and conversion lookback. Editable by operators.'
  ),
  (
    'daily_stations',
    jsonb_build_object(
      'timezone', 'America/Chicago',
      'stations', jsonb_build_array(
        jsonb_build_object('id', 'playlist_discovery_begin', 'local_time', '04:30', 'label', 'Playlist discovery begins'),
        jsonb_build_object('id', 'playlist_tranche_first', 'local_time', '07:00', 'label', 'First playlist tranche ready'),
        jsonb_build_object('id', 'playlist_tranche_final', 'local_time', '08:30', 'label', 'Final playlist tranche + sync discovery begins'),
        jsonb_build_object('id', 'sync_batch_ready', 'local_time', '12:00', 'label', 'Sync batch ready')
      )
    ),
    'Claude station schedule — wall-clock America/Chicago (DST-safe).'
  )
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Daily station run ledger
-- ---------------------------------------------------------------------------
create table if not exists public.daily_ops_station_runs (
  id uuid primary key default gen_random_uuid(),
  -- Idempotency: one logical run per station + CT business date + run_key
  station_id text not null
    check (station_id in (
      'playlist_discovery_begin',
      'playlist_tranche_first',
      'playlist_tranche_final',
      'sync_batch_ready'
    )),
  business_date_ct date not null,
  run_key text not null default 'primary',
  actor_kind text not null,
  actor_label text not null,
  actor_user_id uuid,
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'blocked', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  upstream_station_id text,
  upstream_run_id uuid references public.daily_ops_station_runs(id) on delete set null,
  input_batch_id uuid,
  output_batch_id uuid,
  raw_discoveries int not null default 0,
  unique_discoveries int not null default 0,
  verified_targets int not null default 0,
  drafts_created int not null default 0,
  duplicates int not null default 0,
  rejected_blocked jsonb not null default '[]'::jsonb,
  saturation_indicators jsonb not null default '[]'::jsonb,
  shortfall_reason text,
  error_summary text,
  dependency_failure text,
  metrics jsonb not null default '{}'::jsonb,
  completed_by text,
  completed_by_label text,
  last_resumed_by text,
  last_resumed_by_label text,
  last_resumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station_id, business_date_ct, run_key)
);

create index if not exists daily_ops_station_runs_date_idx
  on public.daily_ops_station_runs (business_date_ct desc, station_id);

alter table public.daily_ops_station_runs enable row level security;

drop policy if exists daily_ops_station_runs_admin_all on public.daily_ops_station_runs;
create policy daily_ops_station_runs_admin_all on public.daily_ops_station_runs
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 3. Grok handoff queues (durable machine-readable states)
-- ---------------------------------------------------------------------------
create table if not exists public.agh_handoff_batches (
  id uuid primary key default gen_random_uuid(),
  batch_kind text not null default 'playlist'
    check (batch_kind in ('playlist', 'sync')),
  queue_state text not null default 'CLAUDE_BATCH_READY'
    check (queue_state in (
      'CLAUDE_BATCH_READY',
      'CLAUDE_PLAYLIST_COMPLETE',
      'AWAITING_GROK_REVIEW',
      'GROK_REVIEWED',
      'APPROVED_FOR_SEND',
      'REJECTED_BY_GROK',
      'AWAITING_AGH_IMPORT',
      'IMPORTED_TO_AGH'
    )),
  business_date_ct date,
  station_run_id uuid references public.daily_ops_station_runs(id) on delete set null,
  upstream_batch_id uuid references public.agh_handoff_batches(id) on delete set null,
  discovered_by text,
  discovered_by_label text,
  verified_by text,
  verified_by_label text,
  drafted_by text,
  drafted_by_label text,
  reviewed_by text,
  reviewed_by_label text,
  approved_by text,
  approved_by_label text,
  rejected_by text,
  rejected_by_label text,
  sent_by text,
  sent_by_label text,
  response_checked_by text,
  response_checked_by_label text,
  placement_checked_by text,
  placement_checked_by_label text,
  song_dna_version_id uuid,
  discovery_profile_ids uuid[] not null default '{}',
  record_count int not null default 0,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agh_handoff_batches_state_idx
  on public.agh_handoff_batches (queue_state, batch_kind, created_at desc);

create table if not exists public.agh_handoff_records (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.agh_handoff_batches(id) on delete cascade,
  record_kind text not null default 'playlist_target'
    check (record_kind in (
      'playlist_target',
      'web_form_packet',
      'instagram_dm_draft',
      'sync_target',
      'sync_opportunity',
      'sync_pitch_draft'
    )),
  queue_state text not null default 'CLAUDE_BATCH_READY'
    check (queue_state in (
      'CLAUDE_BATCH_READY',
      'CLAUDE_PLAYLIST_COMPLETE',
      'AWAITING_GROK_REVIEW',
      'GROK_REVIEWED',
      'APPROVED_FOR_SEND',
      'REJECTED_BY_GROK',
      'AWAITING_AGH_IMPORT',
      'IMPORTED_TO_AGH'
    )),
  playlist_target_id text,
  outreach_draft_id uuid,
  sync_target_id uuid,
  sync_opportunity_id uuid,
  submission_channel text
    check (submission_channel is null or submission_channel in (
      'email', 'web_form', 'instagram_dm'
    )),
  dedupe_key text,
  song_dna_version_id uuid,
  discovered_by text,
  discovered_by_label text,
  verified_by text,
  verified_by_label text,
  drafted_by text,
  drafted_by_label text,
  reviewed_by text,
  reviewed_by_label text,
  approved_by text,
  approved_by_label text,
  rejected_by text,
  rejected_by_label text,
  rejection_reason text,
  packet jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agh_handoff_records_batch_dedupe_uidx
  on public.agh_handoff_records (batch_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists agh_handoff_records_batch_idx
  on public.agh_handoff_records (batch_id, queue_state);

alter table public.agh_handoff_batches enable row level security;
alter table public.agh_handoff_records enable row level security;

drop policy if exists agh_handoff_batches_admin_all on public.agh_handoff_batches;
create policy agh_handoff_batches_admin_all on public.agh_handoff_batches
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists agh_handoff_records_admin_all on public.agh_handoff_records;
create policy agh_handoff_records_admin_all on public.agh_handoff_records
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 4. Multichannel playlist target fields
--    "Verified" = legitimate submission path verified (not email-only).
-- ---------------------------------------------------------------------------
alter table public.playlist_targets
  add column if not exists form_url text,
  add column if not exists form_source_evidence text,
  add column if not exists form_verified_at timestamptz,
  add column if not exists form_requirements text,
  add column if not exists form_cost text,
  add column if not exists form_login_required boolean,
  add column if not exists form_required_fields text[] default '{}',
  add column if not exists form_deadline timestamptz,
  add column if not exists form_manual_submitted_at timestamptz,
  add column if not exists form_manual_submit_result text,
  add column if not exists form_manual_submitted_by text,
  add column if not exists ig_curator_account text,
  add column if not exists ig_source_evidence text,
  add column if not exists ig_verified_at timestamptz,
  add column if not exists ig_dm_draft text,
  add column if not exists ig_manual_submitted_at timestamptz,
  add column if not exists ig_manual_response_status text,
  add column if not exists ig_manual_submitted_by text,
  add column if not exists path_verified boolean not null default false,
  add column if not exists path_verification_notes text,
  add column if not exists discovered_by text,
  add column if not exists discovered_by_label text,
  add column if not exists verified_by text,
  add column if not exists verified_by_label text,
  add column if not exists song_dna_version_id uuid,
  add column if not exists discovery_profile_id uuid;

comment on column public.playlist_targets.path_verified is
  'True when a legitimate submission path (email, web form, or IG DM) has been verified — not merely that an email exists.';

-- ---------------------------------------------------------------------------
-- 5. Discovery profile capacity / saturation extensions
-- ---------------------------------------------------------------------------
alter table public.discovery_profiles
  add column if not exists markets text[] not null default '{}',
  add column if not exists languages text[] not null default '{}',
  add column if not exists playlist_keywords text[] not null default '{}',
  add column if not exists curator_keywords text[] not null default '{}',
  add column if not exists source_domains text[] not null default '{}',
  add column if not exists source_types text[] not null default '{}',
  add column if not exists query_templates text[] not null default '{}',
  add column if not exists query_rotation jsonb not null default '[]'::jsonb,
  add column if not exists negative_terms text[] not null default '{}',
  add column if not exists prior_query_cooldown_hours int not null default 24,
  add column if not exists results_per_query int not null default 25,
  add column if not exists dedupe_key_fields text[] not null default array['playlist_url','curator_email','form_url','ig_curator_account'],
  add column if not exists saturation_history jsonb not null default '[]'::jsonb,
  add column if not exists discovery_yield jsonb not null default '{}'::jsonb;

create table if not exists public.discovery_saturation_log (
  id uuid primary key default gen_random_uuid(),
  discovery_profile_id uuid references public.discovery_profiles(id) on delete set null,
  query_key text not null,
  source_domain text,
  business_date_ct date not null,
  saturated boolean not null default true,
  raw_results int not null default 0,
  unique_results int not null default 0,
  notes text,
  recorded_by text,
  created_at timestamptz not null default now()
);

create unique index if not exists discovery_saturation_log_uidx
  on public.discovery_saturation_log (discovery_profile_id, query_key, business_date_ct);

alter table public.discovery_saturation_log enable row level security;

drop policy if exists discovery_saturation_log_admin_all on public.discovery_saturation_log;
create policy discovery_saturation_log_admin_all on public.discovery_saturation_log
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- 6. Sync research intake (Claude-scoped create; Fendi retains eligibility)
-- ---------------------------------------------------------------------------
create table if not exists public.sync_research_targets (
  id uuid primary key default gen_random_uuid(),
  person_name text,
  company_name text,
  role_category text not null
    check (role_category in (
      'music_supervisor',
      'music_coordinator',
      'sync_agent',
      'licensing_agency',
      'production_music_library',
      'advertising_brand_music_director',
      'film_television_production',
      'trailer_game_music',
      'artist_manager_sync_relevant'
    )),
  official_url text,
  verified_contact_path text,
  contact_channel text
    check (contact_channel is null or contact_channel in (
      'email', 'web_form', 'instagram_dm', 'other'
    )),
  territories text[] not null default '{}',
  media_types text[] not null default '{}',
  genres_styles_sought text[] not null default '{}',
  submission_policy text,
  source_evidence text,
  date_verified timestamptz,
  dedupe_key text not null,
  discovered_by text not null,
  discovered_by_label text not null,
  verified_by text,
  verified_by_label text,
  song_dna_version_id uuid,
  discovery_profile_id uuid,
  batch_id uuid references public.agh_handoff_batches(id) on delete set null,
  status text not null default 'discovered'
    check (status in ('discovered', 'verified', 'rejected', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sync_research_targets_dedupe_uidx
  on public.sync_research_targets (dedupe_key);

create table if not exists public.sync_research_opportunities (
  id uuid primary key default gen_random_uuid(),
  sync_target_id uuid references public.sync_research_targets(id) on delete set null,
  project_brief text not null,
  media_type text,
  deadline timestamptz,
  compensation_public text,
  rights_requested text,
  exclusivity text,
  territory text,
  term text,
  submission_requirements text,
  source_url text,
  source_evidence text,
  recommended_track_ids uuid[] not null default '{}',
  no_eligible_track boolean not null default false,
  no_eligible_track_reason text,
  status text not null default 'open'
    check (status in (
      'open', 'drafted', 'awaiting_review', 'submitted', 'closed', 'rejected'
    )),
  discovered_by text not null,
  discovered_by_label text not null,
  verified_by text,
  verified_by_label text,
  drafted_by text,
  drafted_by_label text,
  song_dna_version_id uuid,
  batch_id uuid references public.agh_handoff_batches(id) on delete set null,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists sync_research_opportunities_dedupe_uidx
  on public.sync_research_opportunities (dedupe_key)
  where dedupe_key is not null;

create table if not exists public.sync_research_pitch_drafts (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.sync_research_opportunities(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  song_dna_version_id uuid,
  subject text,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft', 'superseded', 'approved', 'rejected', 'sent_manual')),
  drafted_by text not null,
  drafted_by_label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sync_research_targets enable row level security;
alter table public.sync_research_opportunities enable row level security;
alter table public.sync_research_pitch_drafts enable row level security;

drop policy if exists sync_research_targets_admin_all on public.sync_research_targets;
create policy sync_research_targets_admin_all on public.sync_research_targets
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists sync_research_opportunities_admin_all on public.sync_research_opportunities;
create policy sync_research_opportunities_admin_all on public.sync_research_opportunities
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists sync_research_pitch_drafts_admin_all on public.sync_research_pitch_drafts;
create policy sync_research_pitch_drafts_admin_all on public.sync_research_pitch_drafts
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

commit;