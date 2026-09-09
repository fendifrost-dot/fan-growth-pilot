begin;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table if not exists public.pitch_campaigns (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.tracks(id) on delete cascade,
  smart_link_id uuid references public.smart_links(id) on delete set null,
  song_dna_version_id uuid references public.song_dna_versions(id) on delete set null,
  status text not null default 'paused',
  daily_target integer not null default 20,
  notes text,
  configuration_snapshot jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  ended_at timestamptz,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pitch_campaigns
  add column if not exists smart_link_id uuid,
  add column if not exists song_dna_version_id uuid,
  add column if not exists status text,
  add column if not exists daily_target integer,
  add column if not exists notes text,
  add column if not exists configuration_snapshot jsonb,
  add column if not exists started_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists paused_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists approved_by uuid,
  add column if not exists created_at timestamptz,
  add column if not exists updated_at timestamptz;

alter table public.pitch_campaigns
  add column if not exists pitch_copy text,
  add column if not exists pitch_subject_template text,
  add column if not exists taxonomy_version text;

update public.pitch_campaigns
   set status = coalesce(nullif(btrim(status), ''), 'paused')
 where status is null or btrim(status) = '';

alter table public.pitch_campaigns alter column status set default 'paused';
alter table public.pitch_campaigns alter column status set not null;

update public.pitch_campaigns
   set daily_target = coalesce(daily_target, 20)
 where daily_target is null;
alter table public.pitch_campaigns alter column daily_target set default 20;
alter table public.pitch_campaigns alter column daily_target set not null;

update public.pitch_campaigns
   set configuration_snapshot = coalesce(configuration_snapshot, '{}'::jsonb)
 where configuration_snapshot is null;
alter table public.pitch_campaigns
  alter column configuration_snapshot set default '{}'::jsonb;
alter table public.pitch_campaigns
  alter column configuration_snapshot set not null;

update public.pitch_campaigns
   set created_at = coalesce(created_at, now())
 where created_at is null;
alter table public.pitch_campaigns alter column created_at set default now();
alter table public.pitch_campaigns alter column created_at set not null;

update public.pitch_campaigns
   set updated_at = coalesce(updated_at, now())
 where updated_at is null;
alter table public.pitch_campaigns alter column updated_at set default now();
alter table public.pitch_campaigns alter column updated_at set not null;

update public.pitch_campaigns
   set activated_at = started_at
 where activated_at is null and started_at is not null;

update public.pitch_campaigns
   set started_at = activated_at
 where started_at is null and activated_at is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pitch_campaigns_track_id_fkey'
      and conrelid = 'public.pitch_campaigns'::regclass
  ) then
    alter table public.pitch_campaigns
      add constraint pitch_campaigns_track_id_fkey
      foreign key (track_id) references public.tracks(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pitch_campaigns_smart_link_id_fkey'
      and conrelid = 'public.pitch_campaigns'::regclass
  ) then
    begin
      alter table public.pitch_campaigns
        add constraint pitch_campaigns_smart_link_id_fkey
        foreign key (smart_link_id) references public.smart_links(id) on delete set null;
    exception when undefined_table then
      raise notice 'smart_links absent — smart_link_id FK deferred';
    end;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pitch_campaigns_song_dna_version_id_fkey'
      and conrelid = 'public.pitch_campaigns'::regclass
  ) then
    begin
      alter table public.pitch_campaigns
        add constraint pitch_campaigns_song_dna_version_id_fkey
        foreign key (song_dna_version_id) references public.song_dna_versions(id) on delete set null;
    exception when undefined_table then
      raise notice 'song_dna_versions absent — song_dna_version_id FK deferred';
    end;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pitch_campaigns_created_by_fkey'
      and conrelid = 'public.pitch_campaigns'::regclass
  ) then
    begin
      alter table public.pitch_campaigns
        add constraint pitch_campaigns_created_by_fkey
        foreign key (created_by) references auth.users(id);
    exception when undefined_table then
      raise notice 'auth.users absent — created_by FK deferred';
    end;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'pitch_campaigns_approved_by_fkey'
      and conrelid = 'public.pitch_campaigns'::regclass
  ) then
    begin
      alter table public.pitch_campaigns
        add constraint pitch_campaigns_approved_by_fkey
        foreign key (approved_by) references auth.users(id);
    exception when undefined_table then
      raise notice 'auth.users absent — approved_by FK deferred';
    end;
  end if;
end $$;

update public.pitch_campaigns
   set status = 'paused',
       paused_at = coalesce(paused_at, now()),
       notes = concat_ws(
         E'\n',
         nullif(notes, ''),
         format(
           '[auto-paused %s] incomplete for current-state contract (need live smart link + approved Song DNA + configuration snapshot).',
           now()::date
         )
       )
 where status = 'active'
   and (
     smart_link_id is null
     or song_dna_version_id is null
     or configuration_snapshot is null
     or configuration_snapshot = '{}'::jsonb
   );

alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_status_check;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_status_check
  check (status in ('draft', 'active', 'paused', 'ended'));

alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_daily_target_check;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_daily_target_check
  check (daily_target between 1 and 200);

alter table public.pitch_campaigns drop constraint if exists pitch_campaigns_active_config_complete;
alter table public.pitch_campaigns
  add constraint pitch_campaigns_active_config_complete
  check (
    status <> 'active'
    or (
      smart_link_id is not null
      and song_dna_version_id is not null
      and configuration_snapshot <> '{}'::jsonb
    )
  );

drop index if exists pitch_campaigns_one_open_per_track;
create unique index pitch_campaigns_one_open_per_track
  on public.pitch_campaigns (track_id)
  where status in ('draft', 'active', 'paused');

create index if not exists pitch_campaigns_status_idx on public.pitch_campaigns (status);
create index if not exists pitch_campaigns_track_idx on public.pitch_campaigns (track_id);
create index if not exists pitch_campaigns_song_dna_idx on public.pitch_campaigns (song_dna_version_id);

create or replace function public.pitch_campaign_guard_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'ended' then
    raise exception 'Campaign % has ended and cannot be reopened (attempted %). Create a new campaign for this track.',
      old.id, new.status;
  end if;

  if new.status = 'draft' and old.status is distinct from 'draft' then
    raise exception 'Campaign % cannot return to draft from %.', old.id, old.status;
  end if;

  if not (
    (old.status = 'draft'  and new.status in ('active', 'paused', 'ended')) or
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
    new.paused_at := coalesce(new.paused_at, now());
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

drop trigger if exists trg_pitch_campaigns_updated_at on public.pitch_campaigns;
create trigger trg_pitch_campaigns_updated_at
  before update on public.pitch_campaigns
  for each row execute function public.touch_updated_at();

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'pitch_log'
  ) then
    alter table public.pitch_log
      add column if not exists campaign_id uuid;
    if not exists (
      select 1 from pg_constraint
      where conname = 'pitch_log_campaign_id_fkey'
        and conrelid = 'public.pitch_log'::regclass
    ) then
      alter table public.pitch_log
        add constraint pitch_log_campaign_id_fkey
        foreign key (campaign_id) references public.pitch_campaigns(id) on delete set null;
    end if;
    create index if not exists pitch_log_campaign_idx on public.pitch_log (campaign_id);
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'outreach_drafts'
  ) then
    alter table public.outreach_drafts
      add column if not exists campaign_id uuid;
    if not exists (
      select 1 from pg_constraint
      where conname = 'outreach_drafts_campaign_id_fkey'
        and conrelid = 'public.outreach_drafts'::regclass
    ) then
      alter table public.outreach_drafts
        add constraint outreach_drafts_campaign_id_fkey
        foreign key (campaign_id) references public.pitch_campaigns(id) on delete set null;
    end if;
    create index if not exists outreach_drafts_campaign_idx on public.outreach_drafts (campaign_id);
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'relationship_history'
  ) then
    alter table public.relationship_history
      add column if not exists campaign_id uuid;
    if not exists (
      select 1 from pg_constraint
      where conname = 'relationship_history_campaign_id_fkey'
        and conrelid = 'public.relationship_history'::regclass
    ) then
      alter table public.relationship_history
        add constraint relationship_history_campaign_id_fkey
        foreign key (campaign_id) references public.pitch_campaigns(id) on delete set null;
    end if;
    create index if not exists relationship_history_campaign_idx
      on public.relationship_history (campaign_id);
  end if;
end $$;

alter table public.pitch_campaigns enable row level security;

drop policy if exists "Service role full access on pitch_campaigns" on public.pitch_campaigns;
create policy "Service role full access on pitch_campaigns"
  on public.pitch_campaigns for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Deny anonymous access to pitch_campaigns" on public.pitch_campaigns;
create policy "Deny anonymous access to pitch_campaigns"
  on public.pitch_campaigns for all
  to anon
  using (false);

drop policy if exists "Deny authenticated direct access to pitch_campaigns" on public.pitch_campaigns;
create policy "Deny authenticated direct access to pitch_campaigns"
  on public.pitch_campaigns for all
  to authenticated
  using (false);

grant all on public.pitch_campaigns to service_role;

commit;