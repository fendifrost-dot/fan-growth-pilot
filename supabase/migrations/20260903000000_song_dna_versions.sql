-- Song DNA versions — Phase 1 foundation for campaign activation + sync readiness.
--
-- LOCKED (docs/PHASE0_LOCKED_DECISIONS.md §3):
--   * Backfill / drafts only — approval_state starts as draft or pending_fendi_review.
--   * Cursor NEVER auto-approves. Only Fendi (admin JWT) can move a version to approved.
--   * Music facts (genre, lanes, sample) are operator/Fendi-entered — not invented here.
--
-- APPLY via Lovable SQL Editor (paste). Safe if pitch_campaigns is still absent:
--   FK from pitch_campaigns.song_dna_version_id is attached only when that table exists.
--
-- Order relative to campaign stack:
--   Prefer applying this AFTER pitch_campaigns exists so the FK attaches in the same run.
--   If pitch_campaigns is null, DNA table still creates; re-run the FK block later
--   (or apply 20260903210000 which re-attaches).

begin;

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

create index if not exists song_dna_versions_track_idx
  on public.song_dna_versions (track_id);
create index if not exists song_dna_versions_state_idx
  on public.song_dna_versions (approval_state);
create unique index if not exists song_dna_versions_one_approved_per_track
  on public.song_dna_versions (track_id)
  where approval_state = 'approved';

comment on table public.song_dna_versions is
  'Versioned Song DNA. Drafts/pending until Fendi approves. Required for campaign activation and sync readiness.';
comment on column public.song_dna_versions.approval_state is
  'draft → pending_fendi_review → approved|rejected. Never auto-approved by migration or Cursor.';
comment on column public.song_dna_versions.sync_recommendation is
  'Operator/Fendi recommendation only. Sample=no never grants sync; Neva stays blocked without license evidence.';

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
create index if not exists song_dna_audit_events_track_idx
  on public.song_dna_audit_events (track_id, created_at desc);

alter table public.song_dna_versions enable row level security;
alter table public.song_dna_audit_events enable row level security;

-- Authenticated operators may read; writes go through service-role edge functions.
drop policy if exists "Authenticated read song_dna_versions" on public.song_dna_versions;
create policy "Authenticated read song_dna_versions"
  on public.song_dna_versions for select
  to authenticated
  using (true);

drop policy if exists "Service role manages song_dna_versions" on public.song_dna_versions;
create policy "Service role manages song_dna_versions"
  on public.song_dna_versions for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Deny anon song_dna_versions" on public.song_dna_versions;
create policy "Deny anon song_dna_versions"
  on public.song_dna_versions for all
  to anon
  using (false);

drop policy if exists "Authenticated read song_dna_audit_events" on public.song_dna_audit_events;
create policy "Authenticated read song_dna_audit_events"
  on public.song_dna_audit_events for select
  to authenticated
  using (true);

drop policy if exists "Service role manages song_dna_audit_events" on public.song_dna_audit_events;
create policy "Service role manages song_dna_audit_events"
  on public.song_dna_audit_events for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Deny anon song_dna_audit_events" on public.song_dna_audit_events;
create policy "Deny anon song_dna_audit_events"
  on public.song_dna_audit_events for all
  to anon
  using (false);

grant select on public.song_dna_versions to authenticated;
grant select on public.song_dna_audit_events to authenticated;
grant all on public.song_dna_versions to service_role;
grant all on public.song_dna_audit_events to service_role;

-- Attach campaign FK when pitch_campaigns exists.
do $$
begin
  if to_regclass('public.pitch_campaigns') is null then
    raise notice 'pitch_campaigns absent — song_dna_version_id FK deferred';
    return;
  end if;

  alter table public.pitch_campaigns
    add column if not exists song_dna_version_id uuid;

  begin
    alter table public.pitch_campaigns
      add constraint pitch_campaigns_song_dna_version_id_fkey
      foreign key (song_dna_version_id)
      references public.song_dna_versions(id)
      on delete set null;
  exception
    when duplicate_object then null;
  end;
end$$;

commit;
