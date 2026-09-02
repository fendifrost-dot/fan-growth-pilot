-- Replace unsafe sync_eligible = (has_sample = 'no') with an explicit,
-- non-inferred boolean that defaults false.
--
-- Locked rule: sample status alone never grants sync eligibility.
-- Fendi sync approval + DNA/sample/rights/assets gates live in application
-- code (evaluateSyncReady); this column is never auto-true from has_sample.
--
-- Also adds pitch_log.track_id + pitch_log.campaign_id for send-path identity.
--
-- Idempotent. Safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop generated sync_eligible; recreate as plain boolean default false
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tracks' and column_name = 'sync_eligible'
  ) then
    alter table public.tracks drop column sync_eligible;
  end if;
end$$;

alter table public.tracks
  add column if not exists sync_eligible boolean not null default false;

comment on column public.tracks.sync_eligible is
  'Explicit sync-ready flag. NEVER inferred from has_sample. Default false. '
  'Application evaluateSyncReady requires approved DNA + Fendi sample/sync '
  'approvals + rights/publishing/assets. Do not set true from sample=no alone.';

-- Ensure any rows that were true solely because has_sample=no are reset.
-- (Dropping the generated column already removed values; default is false.)
update public.tracks set sync_eligible = false where sync_eligible is distinct from false;

-- ---------------------------------------------------------------------------
-- 2. pitch_log identity columns for send-path enforcement
-- ---------------------------------------------------------------------------
alter table public.pitch_log
  add column if not exists track_id uuid references public.tracks(id) on delete set null;

create index if not exists pitch_log_track_id_idx on public.pitch_log (track_id);

-- campaign_id FK only if pitch_campaigns exists; otherwise plain uuid for later.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pitch_log' and column_name = 'campaign_id'
  ) then
    if to_regclass('public.pitch_campaigns') is not null then
      alter table public.pitch_log
        add column campaign_id uuid references public.pitch_campaigns(id) on delete set null;
    else
      alter table public.pitch_log add column campaign_id uuid;
    end if;
  end if;
end$$;

create index if not exists pitch_log_campaign_id_idx on public.pitch_log (campaign_id);

comment on column public.pitch_log.track_id is
  'Exact track UUID required on new sends. Title is display-only.';
comment on column public.pitch_log.campaign_id is
  'Exact campaign UUID required on new sends. Legacy rows may be null.';

commit;
