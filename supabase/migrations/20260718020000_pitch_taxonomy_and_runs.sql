-- Genre taxonomy + run ledger — created in Phase 1, POPULATED in Phase 2.
--
-- Nothing reads these yet. They exist now so the Phase 1 campaign schema does
-- not have to change shape later: campaign_genres is what lets one campaign
-- target a specific lane even when a track legitimately fits several, and
-- pitch_runs is what makes "what did the system do today, and why did it stop"
-- answerable.
--
-- Run this in the Lovable SQL Editor AFTER 20260718010000_pitch_campaigns_phase1.sql.

-- ---------------------------------------------------------------------------
-- 1. Shared normalized genre vocabulary (hierarchical)
-- ---------------------------------------------------------------------------
-- Distinct from the existing `categories` table, which mixes genre/vibe/mood in
-- one flat `family` column with no confidence, provenance, or review state.
-- Phase 2 migrates categories -> genres; both coexist until then.

create table if not exists public.genres (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  display_name text not null,
  parent_genre_id uuid references public.genres(id) on delete set null,
  taxonomy_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug, taxonomy_version)
);

create index if not exists genres_parent_idx on public.genres (parent_genre_id);

-- Every assignment carries provenance and review state, so matching can use
-- APPROVED assignments above a confidence threshold rather than string
-- equality — the thing that makes automated genre matching trustworthy.
do $$
declare t text;
begin
  foreach t in array array['track_genres', 'target_genres', 'campaign_genres'] loop
    execute format($ddl$
      create table if not exists public.%I (
        id uuid primary key default gen_random_uuid(),
        genre_id uuid not null references public.genres(id) on delete cascade,
        confidence numeric not null default 1.0 check (confidence >= 0 and confidence <= 1),
        source text not null check (source in (
          'manual', 'clap_audio', 'playlist_tracklist_classifier',
          'curator_description', 'research_sweep', 'historical_placement'
        )),
        status text not null default 'suggested'
          check (status in ('suggested', 'approved', 'rejected')),
        evidence jsonb not null default '{}'::jsonb,
        model_version text,
        reviewed_by uuid references auth.users(id),
        reviewed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )$ddl$, t);
  end loop;
end $$;

-- Owner columns differ per table, so they're added separately.
alter table public.track_genres
  add column if not exists track_id uuid references public.tracks(id) on delete cascade;
alter table public.target_genres
  add column if not exists target_id text references public.playlist_targets(playlist_id) on delete cascade;
alter table public.campaign_genres
  add column if not exists campaign_id uuid references public.pitch_campaigns(id) on delete cascade;

create unique index if not exists track_genres_unique on public.track_genres (track_id, genre_id);
create unique index if not exists target_genres_unique on public.target_genres (target_id, genre_id);
create unique index if not exists campaign_genres_unique on public.campaign_genres (campaign_id, genre_id);

-- Matching reads hit these hard: approved-only, by owner.
create index if not exists track_genres_approved_idx
  on public.track_genres (track_id) where status = 'approved';
create index if not exists target_genres_approved_idx
  on public.target_genres (target_id) where status = 'approved';
create index if not exists campaign_genres_approved_idx
  on public.campaign_genres (campaign_id) where status = 'approved';

-- ---------------------------------------------------------------------------
-- 2. Run ledger + fair allocation accounting
-- ---------------------------------------------------------------------------

create table if not exists public.pitch_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger_source text not null default 'scheduler'
    check (trigger_source in ('scheduler', 'manual', 'test')),
  global_cap integer not null default 200,
  total_sent integer not null default 0,
  total_skipped integer not null default 0,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'aborted')),
  -- Distinguishes "nothing to do" from "something broke". Without this a quiet
  -- day and an outage look identical in the logs.
  outcome_code text check (outcome_code in (
    'completed', 'insufficient_verified_supply', 'all_targets_in_cooldown',
    'send_window_closed', 'global_guardrail_reached', 'error'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists pitch_runs_started_idx on public.pitch_runs (started_at desc);

-- Per-campaign accounting within a run. `allocated` vs `requested` is what
-- makes round-robin fairness auditable: one send per campaign per pass under
-- the global cap, so the first campaign can never consume the whole allowance.
create table if not exists public.pitch_run_campaigns (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pitch_runs(id) on delete cascade,
  campaign_id uuid not null references public.pitch_campaigns(id) on delete cascade,
  requested integer not null default 0,
  allocated integer not null default 0,
  attempted integer not null default 0,
  sent integer not null default 0,
  skipped integer not null default 0,
  exhausted boolean not null default false,
  outcome_code text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, campaign_id)
);

create index if not exists pitch_run_campaigns_campaign_idx
  on public.pitch_run_campaigns (campaign_id);

-- Backfill the FK left dangling in Phase 1 now that pitch_runs exists.
do $$ begin
  alter table public.campaign_target_attempts
    add constraint campaign_target_attempts_run_fk
    foreign key (run_id) references public.pitch_runs(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. RLS — same backend-table pattern
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'genres', 'track_genres', 'target_genres', 'campaign_genres',
    'pitch_runs', 'pitch_run_campaigns'
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

do $$
declare t text;
begin
  foreach t in array array[
    'genres', 'track_genres', 'target_genres', 'campaign_genres', 'pitch_runs'
  ] loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%I', t, t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['genres', 'track_genres', 'target_genres', 'campaign_genres'] loop
    execute format(
      'create trigger trg_%s_updated_at before update on public.%I for each row execute function public.touch_updated_at()',
      t, t);
  end loop;
end $$;
