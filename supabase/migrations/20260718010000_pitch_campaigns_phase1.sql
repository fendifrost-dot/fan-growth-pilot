-- Pitch Portal Phase 1 — campaigns as the SOLE authority permitting outreach.
--
-- A campaign is not a UI filter. It is a durable system boundary: every pitch
-- must be traceable to the campaign that authorized it, which is why
-- campaign_id lands on pitch_log / outreach_drafts / relationship_history here.
--
-- IDEMPOTENT + ADDITIVE: safe to run whether or not
-- 20260718000000_pitch_campaigns.sql was already applied. If that file was
-- never run, the create-table below establishes the base shape and the alters
-- are no-ops-with-additions; if it WAS run, only the alters take effect.
--
-- Run order:
--   1. 20260718005000_admin_roles.sql
--   2. this file
--   3. 20260718020000_pitch_taxonomy_and_runs.sql
--
-- Run this in the Lovable SQL Editor.

-- ---------------------------------------------------------------------------
-- 1. Base table (no-op if 20260718000000 already ran)
-- ---------------------------------------------------------------------------

create table if not exists public.pitch_campaigns (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  smart_link_id uuid references public.smart_links(id) on delete set null,
  status text not null default 'draft',
  daily_target integer not null default 20,
  notes text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Phase 1 columns
-- ---------------------------------------------------------------------------

alter table public.pitch_campaigns
  add column if not exists pitch_copy text,
  add column if not exists pitch_subject_template text,
  add column if not exists taxonomy_version text,
  -- Freezes copy / smart link / genres / track title+version / artist /
  -- targeting rules / audio-analysis version AT ACTIVATION, so a campaign
  -- report shows what ACTUALLY went out rather than today's mutable track
  -- fields. Written by activate_campaign; never edited in place.
  add column if not exists configuration_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists activated_at timestamptz,
  add column if not exists paused_at timestamptz,
  add column if not exists created_by uuid references auth.users(id);

-- started_at from the earlier migration is superseded by activated_at; keep it
-- populated in lockstep so nothing already reading it breaks.
update public.pitch_campaigns set activated_at = started_at
  where activated_at is null and started_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Constraints (DB guardrail layer)
-- ---------------------------------------------------------------------------

-- If the earlier migration ran, the default is 'active'; campaigns must now
-- begin life as drafts.
alter table public.pitch_campaigns alter column status set default 'draft';

alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_status_check;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_status_check
  check (status in ('draft', 'active', 'paused', 'ended'));

alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_daily_target_check;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_daily_target_check
  check (daily_target between 1 and 100);

-- DESIGN NOTE / deliberate deviation from the brief.
-- The brief asked for smart_link_id and pitch_copy to be NOT NULL at the column
-- level. That is incompatible with the new 'draft' status, whose entire purpose
-- is to hold a half-configured campaign while Fendi fills the gaps. Enforcing
-- them as a CHECK conditioned on status gives the same guarantee where it
-- matters ("an active campaign requires non-null snapshot fields") without
-- making drafts impossible to save.
alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_active_config_complete;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_active_config_complete
  check (
    status = 'draft'
    or (
      smart_link_id is not null
      and pitch_copy is not null
      and length(btrim(pitch_copy)) > 0
      and configuration_snapshot <> '{}'::jsonb
    )
  );

-- Race-safe single OPEN campaign per track. A partial unique index (not
-- UNIQUE(track_id, status)) is what actually prevents two concurrent
-- activations, and still permits unlimited 'ended' history rows.
drop index if exists pitch_campaigns_one_open_per_track;
create unique index if not exists pitch_campaigns_one_open_per_track
  on public.pitch_campaigns (track_id)
  where status in ('draft', 'active', 'paused');

create index if not exists pitch_campaigns_status_idx on public.pitch_campaigns (status);
create index if not exists pitch_campaigns_track_idx on public.pitch_campaigns (track_id);

drop trigger if exists trg_pitch_campaigns_updated_at on public.pitch_campaigns;
create trigger trg_pitch_campaigns_updated_at
  before update on public.pitch_campaigns
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Legal lifecycle transitions (enforced in the DB, not just the action)
-- ---------------------------------------------------------------------------

create or replace function public.pitch_campaign_guard_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  -- 'ended' is terminal: reopening would silently re-attribute new sends to a
  -- campaign whose report has already been read as final.
  if old.status = 'ended' then
    raise exception 'Campaign % has ended and cannot be reopened (attempted %). Create a new campaign for this track.',
      old.id, new.status;
  end if;

  -- Nothing may return to 'draft' once configured and activated.
  if new.status = 'draft' then
    raise exception 'Campaign % cannot return to draft from %.', old.id, old.status;
  end if;

  if not (
    (old.status = 'draft'  and new.status in ('active', 'ended')) or
    (old.status = 'active' and new.status in ('paused', 'ended')) or
    (old.status = 'paused' and new.status in ('active', 'ended'))
  ) then
    raise exception 'Illegal campaign transition % -> % on campaign %.', old.status, new.status, old.id;
  end if;

  if new.status = 'active' then
    new.activated_at := coalesce(new.activated_at, now());
    new.started_at   := coalesce(new.started_at, new.activated_at);
    new.paused_at    := null;
  elsif new.status = 'paused' then
    new.paused_at := now();
  elsif new.status = 'ended' then
    new.ended_at := coalesce(new.ended_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pitch_campaigns_transition on public.pitch_campaigns;
create trigger trg_pitch_campaigns_transition
  before update of status on public.pitch_campaigns
  for each row execute function public.pitch_campaign_guard_transition();

-- ---------------------------------------------------------------------------
-- 5. Archiving a track auto-pauses its open campaigns
-- ---------------------------------------------------------------------------

create or replace function public.pause_campaigns_on_track_archive()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status and new.status <> 'active' then
    update public.pitch_campaigns
       set status = 'paused',
           notes = concat_ws(
             E'\n',
             nullif(notes, ''),
             format('[auto-paused %s] track status changed to "%s".', now()::date, new.status)
           )
     where track_id = new.id
       and status = 'active';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tracks_archive_pauses_campaigns on public.tracks;
create trigger trg_tracks_archive_pauses_campaigns
  after update of status on public.tracks
  for each row execute function public.pause_campaigns_on_track_archive();

-- ---------------------------------------------------------------------------
-- 6. campaign_id everywhere — the traceability requirement
-- ---------------------------------------------------------------------------
-- Nullable for now: the existing smart-link-scoped daily job still writes rows
-- with no campaign context and MUST keep running (Phase 1 does not wire it).
-- Phase 2 flips these to NOT NULL once the send path is campaign-authorized.

alter table public.pitch_log
  add column if not exists campaign_id uuid references public.pitch_campaigns(id) on delete set null;
create index if not exists pitch_log_campaign_idx on public.pitch_log (campaign_id);

alter table public.outreach_drafts
  add column if not exists campaign_id uuid references public.pitch_campaigns(id) on delete set null;
create index if not exists outreach_drafts_campaign_idx on public.outreach_drafts (campaign_id);

-- Placements are NOT a separate table in this schema: they are booleans on
-- pitch_log (placed / placement_status) plus relationship_history rows with
-- event_type = 'placement'. pitch_log is covered above; this covers the RIE
-- event log so a placement can be attributed to the campaign that earned it.
alter table public.relationship_history
  add column if not exists campaign_id uuid references public.pitch_campaigns(id) on delete set null;
create index if not exists relationship_history_campaign_idx on public.relationship_history (campaign_id);

-- ---------------------------------------------------------------------------
-- 7. Idempotent reservations — prevents overlapping runs double-pitching
-- ---------------------------------------------------------------------------
-- Distinct from the 90-day (track_id, target_id) cooldown. This is an ATOMIC
-- claim taken BEFORE drafting/sending: unique(campaign_id, target_id) means a
-- second concurrent run's insert fails rather than producing a duplicate pitch.

create table if not exists public.campaign_target_attempts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.pitch_campaigns(id) on delete cascade,
  target_id text not null references public.playlist_targets(playlist_id) on delete cascade,
  state text not null default 'reserved'
    check (state in ('reserved', 'drafted', 'sent', 'skipped', 'failed', 'released')),
  outcome_code text,
  reserved_at timestamptz not null default now(),
  drafted_at timestamptz,
  sent_at timestamptz,
  released_at timestamptz,
  pitch_log_id uuid references public.pitch_log(id) on delete set null,
  draft_id uuid references public.outreach_drafts(id) on delete set null,
  run_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, target_id)
);

create index if not exists campaign_target_attempts_state_idx
  on public.campaign_target_attempts (campaign_id, state);

drop trigger if exists trg_campaign_target_attempts_updated_at on public.campaign_target_attempts;
create trigger trg_campaign_target_attempts_updated_at
  before update on public.campaign_target_attempts
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Audit events for campaign writes
-- ---------------------------------------------------------------------------

create table if not exists public.campaign_audit_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.pitch_campaigns(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid references auth.users(id),
  actor_kind text not null default 'user' check (actor_kind in ('user', 'scheduler', 'service')),
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists campaign_audit_events_campaign_idx
  on public.campaign_audit_events (campaign_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 9. RLS — backend-table pattern (all access via service-role Edge Functions)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'pitch_campaigns',
    'campaign_target_attempts',
    'campaign_audit_events'
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

-- ---------------------------------------------------------------------------
-- 10. Backfill: seed campaigns for the two songs already being pitched
-- ---------------------------------------------------------------------------
-- DFM and Meditate have live smart links (slugs 'designedforme' / 'meditate',
-- seeded 20260715000000) and existing pitch history. Seeding them as ACTIVE
-- campaigns makes their history attributable without changing what the daily
-- job does today.
--
-- Deliberately NOT a blanket backfill of the whole catalogue — that would
-- recreate the implicit "everything is pitchable" behaviour this table exists
-- to remove. Only these two, because only these two are actually in flight.

with seed(slug, name_pattern) as (
  values ('designedforme', '%designed for me%'),
         ('meditate',      '%meditate%')
),
resolved as (
  select
    t.id  as track_id,
    sl.id as smart_link_id,
    coalesce(nullif(btrim(t.short_pitch), ''),
             format('New release from Fendi Frost — %s.', t.name)) as pitch_copy,
    t.name as track_name
  from seed s
  join public.smart_links sl on sl.slug = s.slug and sl.is_active
  join public.tracks t on lower(t.name) like s.name_pattern and t.status = 'active'
)
insert into public.pitch_campaigns (
  track_id, smart_link_id, status, daily_target, pitch_copy,
  configuration_snapshot, activated_at, started_at, notes
)
select
  r.track_id,
  r.smart_link_id,
  'active',
  20,
  r.pitch_copy,
  jsonb_build_object(
    'seeded_by', '20260718010000_pitch_campaigns_phase1',
    'track_name', r.track_name,
    'pitch_copy', r.pitch_copy,
    'artist', 'Fendi Frost',
    'note', 'Backfilled from in-flight outreach; snapshot reconstructed, not captured at true activation.'
  ),
  now(),
  now(),
  'Seed campaign backfilled for outreach already in flight.'
from resolved r
on conflict do nothing;

-- Attribute existing pitch history to those seed campaigns.
update public.pitch_log pl
   set campaign_id = c.id
  from public.pitch_campaigns c
  join public.tracks t on t.id = c.track_id
 where pl.campaign_id is null
   and lower(btrim(pl.track_name)) = lower(btrim(t.name));

update public.outreach_drafts d
   set campaign_id = c.id
  from public.pitch_campaigns c
  join public.tracks t on t.id = c.track_id
 where d.campaign_id is null
   and lower(btrim(d.track_name)) = lower(btrim(t.name));
