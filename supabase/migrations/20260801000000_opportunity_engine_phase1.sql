-- Opportunity Engine — Phase 1 schema (Minimum Viable Opportunity System).
--
-- Introduces the UNIFIED opportunity data model that ties the existing per-channel
-- silos (playlist_targets, radio_targets, relationships, fan_profiles) together
-- behind a single abstraction: a growth_entity we could work with, and a scored
-- growth_opportunity to do something specific with it now.
--
-- DESIGN PRINCIPLES
--   * REUSE, don't rebuild. songs are the existing public.tracks table (extended,
--     not duplicated). Relationship signals bridge to the existing RIE
--     (public.relationships / relationship_history) rather than replacing it.
--   * DETERMINISTIC scoring. Eight score COMPONENTS are stored separately from the
--     composite opportunity_score. There is NO ML model; the service layer computes
--     these from documented, configurable weights (see src/lib/opportunities/scoring.ts).
--   * EVIDENCE IS PRESERVED. discovery_evidence keeps the original reason a row was
--     surfaced; it is never overwritten by rescoring.
--   * HUMAN OVERRIDES. score_overridden / manual_score let a person pin a score.
--   * DEDUPE. growth_opportunities.dedupe_key (UNIQUE) prevents duplicates, mirroring
--     the proven public.relationships.dedupe_key pattern.
--
-- SECURITY: backend-table pattern (identical to 20260718010000 §9). RLS ON; all
-- access flows through the authenticated `opportunities-api` Edge Function
-- (service-role server-side, JWT+admin-role authorized). Direct anon/authenticated
-- client access is DENIED, so no service-role credential ever reaches the browser.
--
-- IDEMPOTENT + ADDITIVE: safe to run more than once.
--
-- Run this in the Lovable SQL Editor. It is ALSO committed here as the
-- version-controlled source of truth (Definition of Done).

-- ---------------------------------------------------------------------------
-- 0. Self-contained updated_at helper
-- ---------------------------------------------------------------------------
-- The repo references public.touch_updated_at() but never defines it in a
-- version-controlled migration (it lives only in the live Lovable DB). To keep
-- this migration self-standing we define our OWN dedicated trigger function with
-- a distinct name so we can never clobber a differing live definition.

create or replace function public.growth_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Extend the canonical song table (public.tracks) — do NOT duplicate it
-- ---------------------------------------------------------------------------
-- duration_seconds is needed to validate that a song clip's end never exceeds
-- the track length (enforced in the service layer + tests, since a cross-table
-- CHECK cannot reference tracks from song_clips).

alter table public.tracks
  add column if not exists duration_seconds integer;

alter table public.tracks drop constraint if exists tracks_duration_seconds_check;
alter table public.tracks
  add constraint tracks_duration_seconds_check
  check (duration_seconds is null or duration_seconds > 0);

-- ---------------------------------------------------------------------------
-- 2. growth_entities — anything we could build a growth relationship with
-- ---------------------------------------------------------------------------

create table if not exists public.growth_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  name text not null,
  canonical_url text,
  platform text,
  platform_external_id text,
  description text,
  location text,
  metadata jsonb not null default '{}'::jsonb,
  -- Optional bridges to the existing per-channel silos this entity was drawn from.
  playlist_target_id text references public.playlist_targets(playlist_id) on delete set null,
  radio_target_id uuid references public.radio_targets(id) on delete set null,
  relationship_id uuid references public.relationships(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint growth_entities_type_check check (entity_type in (
    'playlist','creator','conversation','dj','radio_station','radio_program',
    'publication','journalist','newsletter','podcast','event','venue',
    'community','brand','collaborator','fan'
  ))
);

-- Unique on NORMALIZED platform + external id. Partial (WHERE external id present)
-- so manually-entered entities without a platform id are still allowed. lower()
-- both sides is the normalization; the service layer trims before insert.
drop index if exists growth_entities_platform_external_uniq;
create unique index growth_entities_platform_external_uniq
  on public.growth_entities (lower(platform), lower(platform_external_id))
  where platform_external_id is not null and platform is not null;

create index if not exists growth_entities_type_idx on public.growth_entities (entity_type);
create index if not exists growth_entities_platform_idx on public.growth_entities (platform);
create index if not exists growth_entities_relationship_idx on public.growth_entities (relationship_id);

drop trigger if exists trg_growth_entities_updated_at on public.growth_entities;
create trigger trg_growth_entities_updated_at
  before update on public.growth_entities
  for each row execute function public.growth_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. growth_opportunities — a scored, actionable thing to do with an entity now
-- ---------------------------------------------------------------------------
-- Score model: every component AND the composite are on a uniform 0..100 scale.
-- response_probability / conversion_probability are modeled probabilities
-- expressed as percentages (0..100) so the whole row shares one scale and the UI
-- needs no per-field unit handling. The deterministic weighting lives in
-- src/lib/opportunities/scoring.ts (CONFIGURABLE, documented).

create table if not exists public.growth_opportunities (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.growth_entities(id) on delete cascade,
  source_platform text,
  opportunity_type text not null,
  source_url text,
  title text not null,
  why_discovered text,
  discovery_evidence jsonb not null default '{}'::jsonb,

  -- Eight score COMPONENTS, stored separately (nullable until scored).
  audience_match_score numeric,
  relationship_score numeric,
  reach_score numeric,
  response_probability numeric,
  conversion_probability numeric,
  effort_score numeric,
  risk_score numeric,
  lifetime_value_score numeric,
  -- Composite + provenance of the weights that produced it.
  opportunity_score numeric,
  score_version text,
  scored_at timestamptz,

  -- Human override (pins the effective score; original components are retained).
  score_overridden boolean not null default false,
  manual_score numeric,
  override_reason text,

  -- Recommended play.
  recommended_song_id uuid references public.tracks(id) on delete set null,
  recommended_start_seconds integer,
  recommended_end_seconds integer,
  recommended_action text,
  generated_message text,

  -- Lifecycle.
  status text not null default 'new',
  assigned_to uuid references auth.users(id),
  discovered_at timestamptz not null default now(),
  snoozed_until timestamptz,
  acted_at timestamptz,

  -- Dedupe key (service-computed: entity|type|song-or-url, normalized).
  dedupe_key text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint growth_opportunities_status_check check (status in (
    'new','reviewing','approved','rejected','snoozed',
    'in_progress','contacted','responded','converted','closed'
  )),
  constraint growth_opportunities_dedupe_uniq unique (dedupe_key),
  -- All score fields, when present, are 0..100.
  constraint growth_opportunities_score_ranges check (
    (audience_match_score   is null or audience_match_score   between 0 and 100) and
    (relationship_score     is null or relationship_score     between 0 and 100) and
    (reach_score            is null or reach_score            between 0 and 100) and
    (response_probability   is null or response_probability   between 0 and 100) and
    (conversion_probability is null or conversion_probability between 0 and 100) and
    (effort_score           is null or effort_score           between 0 and 100) and
    (risk_score             is null or risk_score             between 0 and 100) and
    (lifetime_value_score   is null or lifetime_value_score   between 0 and 100) and
    (opportunity_score      is null or opportunity_score      between 0 and 100) and
    (manual_score           is null or manual_score           between 0 and 100)
  ),
  -- Clip window sanity (further validated against track duration in the service).
  constraint growth_opportunities_clip_window check (
    (recommended_start_seconds is null or recommended_start_seconds >= 0) and
    (recommended_end_seconds is null or recommended_start_seconds is null
       or recommended_end_seconds > recommended_start_seconds)
  )
);

create index if not exists growth_opportunities_status_idx on public.growth_opportunities (status);
create index if not exists growth_opportunities_type_idx on public.growth_opportunities (opportunity_type);
create index if not exists growth_opportunities_platform_idx on public.growth_opportunities (source_platform);
create index if not exists growth_opportunities_entity_idx on public.growth_opportunities (entity_id);
create index if not exists growth_opportunities_song_idx on public.growth_opportunities (recommended_song_id);
create index if not exists growth_opportunities_assigned_idx on public.growth_opportunities (assigned_to);
create index if not exists growth_opportunities_snoozed_idx on public.growth_opportunities (snoozed_until);
create index if not exists growth_opportunities_discovered_idx on public.growth_opportunities (discovered_at desc);
-- Inbox default sort: highest score first among open statuses.
create index if not exists growth_opportunities_score_idx on public.growth_opportunities (opportunity_score desc nulls last);

drop trigger if exists trg_growth_opportunities_updated_at on public.growth_opportunities;
create trigger trg_growth_opportunities_updated_at
  before update on public.growth_opportunities
  for each row execute function public.growth_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. growth_relationship_events — the signal log that feeds relationship memory
-- ---------------------------------------------------------------------------
-- Complements (does not replace) the RIE's relationship_history. Bridges to an
-- RIE relationship_id when one exists so the two stay reconcilable.

create table if not exists public.growth_relationship_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.growth_entities(id) on delete cascade,
  opportunity_id uuid references public.growth_opportunities(id) on delete set null,
  relationship_id uuid references public.relationships(id) on delete set null,
  event_type text not null,
  direction text not null default 'system'
    check (direction in ('inbound','outbound','system')),
  channel text,
  occurred_at timestamptz not null default now(),
  -- Signed contribution to the relationship component (aggregated by the service).
  weight numeric not null default 0,
  -- Idempotency, mirroring relationship_history.
  source text,
  source_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint growth_rel_events_idem unique (source, source_id, event_type)
);

create index if not exists growth_rel_events_entity_idx on public.growth_relationship_events (entity_id);
create index if not exists growth_rel_events_opp_idx on public.growth_relationship_events (opportunity_id);
create index if not exists growth_rel_events_rel_idx on public.growth_relationship_events (relationship_id);
create index if not exists growth_rel_events_occurred_idx on public.growth_relationship_events (occurred_at desc);

-- ---------------------------------------------------------------------------
-- 5. song_intelligence_profiles — structured song intelligence (1 per track)
-- ---------------------------------------------------------------------------

create table if not exists public.song_intelligence_profiles (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  bpm numeric,
  musical_key text,
  mode text check (mode is null or mode in ('major','minor')),
  energy numeric check (energy is null or energy between 0 and 1),
  valence numeric check (valence is null or valence between 0 and 1),
  danceability numeric check (danceability is null or danceability between 0 and 1),
  acousticness numeric check (acousticness is null or acousticness between 0 and 1),
  instrumentalness numeric check (instrumentalness is null or instrumentalness between 0 and 1),
  mood_tags text[] not null default '{}',
  genre_tags text[] not null default '{}',
  sonic_descriptors text[] not null default '{}',
  similar_artists text[] not null default '{}',
  summary text,
  source text,                       -- manual | spotify_audio_features | llm | ...
  confidence numeric check (confidence is null or confidence between 0 and 1),
  analysis_version text,
  raw jsonb not null default '{}'::jsonb,   -- original analysis evidence, preserved
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint song_intelligence_one_per_track unique (track_id)
);

create index if not exists song_intelligence_track_idx on public.song_intelligence_profiles (track_id);

drop trigger if exists trg_song_intelligence_updated_at on public.song_intelligence_profiles;
create trigger trg_song_intelligence_updated_at
  before update on public.song_intelligence_profiles
  for each row execute function public.growth_set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. song_clips — timestamped hooks/clips for timestamp matching
-- ---------------------------------------------------------------------------

create table if not exists public.song_clips (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  label text,
  start_seconds integer not null,
  end_seconds integer not null,
  purpose text,                      -- pitch | reel | story | ...
  status text not null default 'proposed'
    check (status in ('proposed','approved','rejected')),
  transcript text,
  notes text,
  audio_url text,
  waveform_url text,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint song_clips_window_check check (start_seconds >= 0 and end_seconds > start_seconds),
  constraint song_clips_dedupe_uniq unique (track_id, start_seconds, end_seconds)
);

create index if not exists song_clips_track_idx on public.song_clips (track_id);
create index if not exists song_clips_status_idx on public.song_clips (status);

drop trigger if exists trg_song_clips_updated_at on public.song_clips;
create trigger trg_song_clips_updated_at
  before update on public.song_clips
  for each row execute function public.growth_set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. opportunity_actions — append-only audit trail of decisions on an opportunity
-- ---------------------------------------------------------------------------

create table if not exists public.opportunity_actions (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.growth_opportunities(id) on delete cascade,
  action_type text not null,         -- approve|reject|snooze|generate_message|edit_message|
                                      -- mark_contacted|mark_responded|mark_converted|open_source|
                                      -- assign|override_score|note
  actor_user_id uuid references auth.users(id),
  actor_kind text not null default 'user' check (actor_kind in ('user','scheduler','service')),
  from_status text,
  to_status text,
  channel text,
  message_used text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists opportunity_actions_opp_idx
  on public.opportunity_actions (opportunity_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 8. opportunity_outcomes — measured results (append log feeding the learning loop)
-- ---------------------------------------------------------------------------

create table if not exists public.opportunity_outcomes (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.growth_opportunities(id) on delete cascade,
  outcome_type text not null,        -- contacted|responded|positive|negative|converted|
                                      -- no_response|closed_lost|closed_won
  succeeded boolean,                 -- null = not yet known
  response_received boolean not null default false,
  converted boolean not null default false,
  conversion_value numeric not null default 0,   -- realized lifetime value
  responded_at timestamptz,
  converted_at timestamptz,
  notes text,
  recorded_by uuid references auth.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists opportunity_outcomes_opp_idx
  on public.opportunity_outcomes (opportunity_id, created_at desc);

drop trigger if exists trg_opportunity_outcomes_updated_at on public.opportunity_outcomes;
create trigger trg_opportunity_outcomes_updated_at
  before update on public.opportunity_outcomes
  for each row execute function public.growth_set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. RLS — backend-table pattern (all access via the service-role Edge Function)
-- ---------------------------------------------------------------------------
-- Identical policy shape to 20260718010000 §9: service_role full access, anon and
-- authenticated DENIED direct access. Authorization for callers is enforced in the
-- opportunities-api Edge Function (JWT + admin role), so the browser never holds a
-- service-role key and cannot bypass the gate by hitting PostgREST directly.

do $$
declare t text;
begin
  foreach t in array array[
    'growth_entities',
    'growth_opportunities',
    'growth_relationship_events',
    'song_intelligence_profiles',
    'song_clips',
    'opportunity_actions',
    'opportunity_outcomes'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "Service role full access on %s" on public.%I', t, t);
    execute format(
      'create policy "Service role full access on %s" on public.%I for all to service_role using (true) with check (true)',
      t, t);

    execute format('drop policy if exists "Deny anonymous access to %s" on public.%I', t, t);
    execute format(
      'create policy "Deny anonymous access to %s" on public.%I for all to anon using (false)', t, t);

    execute format('drop policy if exists "Deny authenticated direct access to %s" on public.%I', t, t);
    execute format(
      'create policy "Deny authenticated direct access to %s" on public.%I for all to authenticated using (false)',
      t, t);

    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
