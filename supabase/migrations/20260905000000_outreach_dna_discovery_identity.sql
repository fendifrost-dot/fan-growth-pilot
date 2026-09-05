-- Outreach DNA architecture: Song DNA, discovery profiles, exact identity columns,
-- shadow decision log, configuration audit.
--
-- APPLY via Lovable SQL Editor (paste). Does NOT arm the send gate.
-- Backfilled discovery profiles start as pending_fendi_review (never auto-approved).
-- Runtime gate mode defaults to 'shadow' via artist_config (see seed below).

begin;

-- ---------------------------------------------------------------------------
-- Song DNA versions (Fendi-approved music identity)
-- ---------------------------------------------------------------------------
create table if not exists public.song_dna_versions (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  version_number integer not null,
  approval_state text not null default 'draft'
    check (approval_state in ('draft', 'pending_fendi_review', 'approved', 'rejected')),
  primary_genre text,
  secondary_genres text[] not null default '{}',
  approved_lanes text[] not null default '{}',
  excluded_lanes text[] not null default '{}',
  mood_tags text[] not null default '{}',
  context_tags text[] not null default '{}',
  reference_artists text[] not null default '{}',
  short_pitch text,
  bpm_hint numeric,
  energy_hint numeric,
  sample_declaration text not null default 'unknown'
    check (sample_declaration in ('yes', 'no', 'unknown')),
  sync_recommendation text not null default 'blocked'
    check (sync_recommendation in ('blocked', 'candidate', 'approved', 'rejected')),
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (track_id, version_number)
);

create index if not exists song_dna_versions_track_idx on public.song_dna_versions (track_id);
create index if not exists song_dna_versions_state_idx on public.song_dna_versions (approval_state);
create unique index if not exists song_dna_versions_one_approved_per_track
  on public.song_dna_versions (track_id) where approval_state = 'approved';

comment on table public.song_dna_versions is
  'Versioned Song DNA. Never auto-approved by migration or agent. Fendi JWT only.';
comment on column public.song_dna_versions.short_pitch is
  'Approved song-specific pitch copy. Sole source for {{pitch}} once gate is enforced.';

create table if not exists public.song_dna_audit_events (
  id uuid primary key default gen_random_uuid(),
  song_dna_version_id uuid not null references public.song_dna_versions(id) on delete cascade,
  track_id uuid not null references public.tracks(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind text not null default 'user'
    check (actor_kind in ('user', 'service', 'system')),
  from_state text,
  to_state text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists song_dna_audit_events_dna_idx
  on public.song_dna_audit_events (song_dna_version_id, created_at desc);

alter table public.song_dna_versions enable row level security;
alter table public.song_dna_audit_events enable row level security;

drop policy if exists song_dna_versions_admin_all on public.song_dna_versions;
create policy song_dna_versions_admin_all on public.song_dna_versions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists song_dna_audit_admin_select on public.song_dna_audit_events;
create policy song_dna_audit_admin_select on public.song_dna_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------
-- Discovery profiles (replace hardcoded RAP/HOUSE subgenre arrays)
-- ---------------------------------------------------------------------------
create table if not exists public.discovery_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_key text not null unique,
  label text not null,
  is_active boolean not null default true,
  approval_status text not null default 'pending_fendi_review'
    check (approval_status in ('pending_fendi_review', 'approved', 'rejected', 'deprecated')),
  category_ids uuid[] not null default '{}',
  genre_family text,
  included_search_terms text[] not null default '{}',
  excluded_search_terms text[] not null default '{}',
  reference_artists text[] not null default '{}',
  compatible_target_category_slugs text[] not null default '{}',
  search_weight numeric not null default 1.0,
  approved_lanes text[] not null default '{}',
  excluded_lanes text[] not null default '{}',
  matching_expression text,
  allocation_share numeric,
  editor_user_id uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discovery_profiles_active_idx
  on public.discovery_profiles (is_active) where is_active;

comment on table public.discovery_profiles is
  'Operator-editable discovery/routing profiles. Seeded pending Fendi review — not auto-approved.';

create table if not exists public.discovery_profile_audit_events (
  id uuid primary key default gen_random_uuid(),
  discovery_profile_id uuid not null references public.discovery_profiles(id) on delete restrict,
  event_type text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

alter table public.discovery_profiles enable row level security;
alter table public.discovery_profile_audit_events enable row level security;

drop policy if exists discovery_profiles_admin_all on public.discovery_profiles;
create policy discovery_profiles_admin_all on public.discovery_profiles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists discovery_profile_audit_admin_select on public.discovery_profile_audit_events;
create policy discovery_profile_audit_admin_select on public.discovery_profile_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- Soft-delete protection: no hard delete of referenced profiles (app enforces deactivate).
-- Seed pending profiles from former source literals (historical migrate → pending review).
insert into public.discovery_profiles (
  profile_key, label, is_active, approval_status, genre_family,
  included_search_terms, approved_lanes, search_weight, allocation_share
) values
(
  'rap_catalogue',
  'Rap / Hip-Hop discovery',
  true,
  'pending_fendi_review',
  'rap',
  array[
    'trap','drill','boom bap','melodic rap','rage rap','west coast rap',
    'east coast rap','southern hip hop','underground hip hop','lofi rap',
    'conscious rap','hard rap','club rap','party rap','gangsta rap','g-funk',
    'phonk','plugg','hip hop','rap','new rap','hip hop 2026'
  ],
  array['rap_trap_hype','rap_conscious','rap_general'],
  1.0,
  0.55
),
(
  'house_electronic_catalogue',
  'House / Electronic discovery',
  true,
  'pending_fendi_review',
  'house',
  array[
    'deep house','tech house','afro house','soulful house','bass house',
    'progressive house','melodic house','organic house','disco house',
    'funky house','vocal house','amapiano','house'
  ],
  array['house_club','house_general','deep_house_groove'],
  1.0,
  0.45
)
on conflict (profile_key) do nothing;

-- ---------------------------------------------------------------------------
-- Exact operational identity columns
-- ---------------------------------------------------------------------------
alter table public.outreach_drafts
  add column if not exists track_id uuid references public.tracks(id) on delete set null,
  add column if not exists song_dna_version_id uuid references public.song_dna_versions(id) on delete set null,
  add column if not exists campaign_id uuid;

alter table public.pitch_log
  add column if not exists track_id uuid references public.tracks(id) on delete set null,
  add column if not exists song_dna_version_id uuid references public.song_dna_versions(id) on delete set null,
  add column if not exists campaign_id uuid;

create index if not exists outreach_drafts_track_id_idx on public.outreach_drafts (track_id);
create index if not exists pitch_log_track_id_idx on public.pitch_log (track_id);

-- Pointer from catalogue track → current Fendi-approved DNA (never set by migration seed).
alter table public.tracks
  add column if not exists approved_song_dna_version_id uuid
    references public.song_dna_versions(id) on delete set null;

-- Attach campaign FK only when pitch_campaigns exists
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'pitch_campaigns'
  ) then
    begin
      alter table public.outreach_drafts
        drop constraint if exists outreach_drafts_campaign_id_fkey;
      alter table public.outreach_drafts
        add constraint outreach_drafts_campaign_id_fkey
        foreign key (campaign_id) references public.pitch_campaigns(id) on delete set null;
    exception when others then
      raise notice 'outreach_drafts.campaign_id FK skipped: %', SQLERRM;
    end;

    begin
      alter table public.pitch_campaigns
        add column if not exists song_dna_version_id uuid references public.song_dna_versions(id) on delete set null;
    exception when others then
      raise notice 'pitch_campaigns.song_dna_version_id skipped: %', SQLERRM;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Shadow decision log + generic configuration audit
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_decision_shadow_log (
  id uuid primary key default gen_random_uuid(),
  route text not null,
  mode text not null,
  would_allow boolean not null,
  decision_code text not null,
  track_id uuid,
  song_dna_version_id uuid,
  campaign_id uuid,
  playlist_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists outreach_decision_shadow_log_created_idx
  on public.outreach_decision_shadow_log (created_at desc);

create table if not exists public.agh_config_audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  event_type text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  approval_status text,
  version_activated text,
  created_at timestamptz not null default now()
);

create index if not exists agh_config_audit_entity_idx
  on public.agh_config_audit_events (entity_type, entity_id, created_at desc);

alter table public.outreach_decision_shadow_log enable row level security;
alter table public.agh_config_audit_events enable row level security;

drop policy if exists outreach_shadow_admin_select on public.outreach_decision_shadow_log;
create policy outreach_shadow_admin_select on public.outreach_decision_shadow_log
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists agh_config_audit_admin_select on public.agh_config_audit_events;
create policy agh_config_audit_admin_select on public.agh_config_audit_events
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- Gate mode retired: outreach decision is always enforced.
-- Keep key for operators who still look it up; value must be enforce.
insert into public.artist_config (key, value)
values (
  'outreach_dna_gate_mode',
  '"enforce"'::jsonb
)
on conflict (key) do update set value = '"enforce"'::jsonb;

-- Lyric decoder slot (disabled until a provider is chosen).
insert into public.artist_config (key, value)
values (
  'lyric_decoder',
  '{"provider":"none","enabled":false}'::jsonb
)
on conflict (key) do nothing;

-- Fendi-only override audit sink
create table if not exists public.outreach_mismatch_overrides (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  song_dna_version_id uuid not null references public.song_dna_versions(id) on delete cascade,
  campaign_id uuid not null,
  playlist_id text not null,
  reason text not null,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.outreach_mismatch_overrides enable row level security;
drop policy if exists outreach_mismatch_overrides_admin_all on public.outreach_mismatch_overrides;
create policy outreach_mismatch_overrides_admin_all on public.outreach_mismatch_overrides
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

commit;
