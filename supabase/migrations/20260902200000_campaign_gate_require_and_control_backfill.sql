-- Campaign gate REQUIRE + VERIFY + Control historical track_id backfill.
--
-- BLOCKER FIX (PR #8 re-review):
--   * Earlier 20260902000000 no-op'd when pitch_campaigns was absent, then
--     20260902120000 added pitch_log.campaign_id WITHOUT an FK.
--   * This migration FAILS LOUDLY unless pitch_campaigns exists, then
--     adds/verifies every activation-gate column, constraint, and FK.
--   * Also backfills Control (Designed For Me) historical pitch_log.track_id
--     so the same-target cooldown can see prior submissions.
--
-- APPLY ORDER (Lovable SQL Editor — paste, don't type):
--   1. 20260718005000_admin_roles.sql          (if not applied)
--   2. 20260718000000_pitch_campaigns.sql
--   3. 20260718010000_pitch_campaigns_phase1.sql  (revised draft seed)
--   4. 20260902000000_pitch_campaigns_activation_gate.sql
--   5. 20260902120000_replace_sync_eligible_and_pitch_identity.sql
--   6. THIS FILE
--
-- Do NOT redeploy gated senders until Song DNA schema + Fendi approvals +
-- at least one live active campaign exist (atomic cutover).

begin;

-- ---------------------------------------------------------------------------
-- 0. Fail loudly if campaign table is missing
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.pitch_campaigns') is null then
    raise exception
      'BLOCKED: public.pitch_campaigns does not exist. Apply 20260718000000 + 20260718010000 (revised draft seed) + 20260902000000 BEFORE this migration. Refusing to leave campaign_id without FK / gate columns.';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 1. Ensure every activation-gate column exists
-- ---------------------------------------------------------------------------
alter table public.pitch_campaigns
  add column if not exists authority_kind text not null default 'live';

alter table public.pitch_campaigns
  drop constraint if exists pitch_campaigns_authority_kind_chk;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_authority_kind_chk
  check (authority_kind in ('live', 'legacy_reconstructed'));

alter table public.pitch_campaigns
  add column if not exists song_dna_version_id uuid,
  add column if not exists fendi_activation_approved_by text,
  add column if not exists fendi_activation_approved_at timestamptz,
  add column if not exists pitch_copy text,
  add column if not exists configuration_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists activated_at timestamptz;

alter table public.pitch_campaigns alter column status set default 'draft';

-- status must include draft
alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_status_check;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_status_check
  check (status in ('draft', 'active', 'paused', 'ended'));

-- Active campaigns require frozen snapshot + pitch_copy + Fendi evidence.
alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_active_config_complete;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_active_config_complete
  check (
    status <> 'active'
    or (
      smart_link_id is not null
      and pitch_copy is not null
      and length(btrim(pitch_copy)) > 0
      and configuration_snapshot <> '{}'::jsonb
      and song_dna_version_id is not null
      and fendi_activation_approved_by is not null
      and fendi_activation_approved_at is not null
      and authority_kind = 'live'
    )
  );

-- One open campaign per track (draft|active|paused)
drop index if exists pitch_campaigns_one_open_per_track;
create unique index if not exists pitch_campaigns_one_open_per_track
  on public.pitch_campaigns (track_id)
  where status in ('draft', 'active', 'paused');

-- Label July reconstructed drafts as legacy
update public.pitch_campaigns
set authority_kind = 'legacy_reconstructed'
where coalesce(configuration_snapshot->>'seeded_by', '') = '20260718010000_pitch_campaigns_phase1'
   or coalesce(configuration_snapshot->>'authority_kind', '') = 'legacy_reconstructed'
   or coalesce(notes, '') ilike '%Legacy reconstructed%';

-- ---------------------------------------------------------------------------
-- 2. pitch_log identity columns + REAL FK to pitch_campaigns
-- ---------------------------------------------------------------------------
alter table public.pitch_log
  add column if not exists track_id uuid references public.tracks(id) on delete set null;

-- Drop bare campaign_id if it exists without FK, then re-add with FK.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pitch_log' and column_name = 'campaign_id'
  ) then
    -- Drop any existing FK on campaign_id then the column, to recreate cleanly.
    alter table public.pitch_log drop constraint if exists pitch_log_campaign_id_fkey;
  else
    null;
  end if;
end$$;

alter table public.pitch_log
  add column if not exists campaign_id uuid;

-- Attach FK (idempotent via exception swallow if already present)
do $$
begin
  alter table public.pitch_log
    add constraint pitch_log_campaign_id_fkey
    foreign key (campaign_id) references public.pitch_campaigns(id) on delete set null;
exception
  when duplicate_object then null;
end$$;

create index if not exists pitch_log_track_id_idx on public.pitch_log (track_id);
create index if not exists pitch_log_campaign_id_idx on public.pitch_log (campaign_id);

-- ---------------------------------------------------------------------------
-- 3. Re-verify Control historical track_id backfill
--    Primary apply is 20260902190000 (independent of pitch_campaigns).
--    This block is idempotent and fails loud if any leftover remains.
-- ---------------------------------------------------------------------------
update public.pitch_log
set track_id = '5d09da7e-98cf-4276-8dca-861d1fbbfa98'::uuid
where track_id is null
  and status = 'sent'
  and lower(coalesce(track_name, '')) like '%designed for me%';

do $$
declare
  leftover int;
begin
  select count(*) into leftover
  from public.pitch_log
  where status = 'sent'
    and track_id is null
    and lower(coalesce(track_name, '')) like '%designed for me%';
  if leftover > 0 then
    raise exception 'Control track_id backfill incomplete: % sent rows still null', leftover;
  end if;
end$$;

commit;

-- POST-APPLY VERIFICATION (run separately; do not invent results):
--   select count(*) from pitch_log
--    where status='sent' and track_id='5d09da7e-98cf-4276-8dca-861d1fbbfa98';
--   select count(*) from pitch_log
--    where status='sent' and track_id is null and lower(track_name) like '%designed for me%';
--   -- expect second query = 0
--   select column_name from information_schema.columns
--    where table_name='pitch_campaigns'
--      and column_name in ('authority_kind','song_dna_version_id',
--                          'fendi_activation_approved_by','fendi_activation_approved_at');
--   select conname from pg_constraint where conname = 'pitch_log_campaign_id_fkey';
