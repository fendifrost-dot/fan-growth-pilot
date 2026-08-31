-- Operator-only song flags + music-supervisor roster + licensing pitch log.
--
-- Titles only in the seed. Do NOT mint or write ISRCs.
-- Licensing log starts empty — no licenses exist and none are in the pipeline.
-- Do not import historical email contacts here.
--
-- Genre rules:
--   Meditate = Hip-Hop/Rap, no sample, month-1 sync default. NEVER house.
--   House/electronic pool is ONLY Balenciaga (Let Me Freeze), Electrilla,
--   Designed For Me (Control).
--   Neva Too Much Prada has a Splice saxophone sample → not sync-eligible.
--   A DistroKid miss is not "unreleased"; aggregator defaults to OPEN.

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-song sync flags on public.tracks
-- ---------------------------------------------------------------------------
alter table public.tracks
  add column if not exists aggregator text not null default 'open';

alter table public.tracks
  add column if not exists genre_stamp text not null default 'unknown';

alter table public.tracks
  add column if not exists has_sample text not null default 'unknown';

alter table public.tracks
  add column if not exists is_month1_sync_default boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tracks_aggregator_chk'
  ) then
    alter table public.tracks
      add constraint tracks_aggregator_chk
      check (aggregator in ('distrokid', 'tunecore', 'orchard', 'open'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'tracks_genre_stamp_chk'
  ) then
    alter table public.tracks
      add constraint tracks_genre_stamp_chk
      check (genre_stamp in ('hip_hop_rap', 'house_electronic', 'unknown'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'tracks_has_sample_chk'
  ) then
    alter table public.tracks
      add constraint tracks_has_sample_chk
      check (has_sample in ('yes', 'no', 'unknown'));
  end if;
end$$;

-- Generated: sync-eligible only when the operator has confirmed no sample.
alter table public.tracks
  add column if not exists sync_eligible boolean
  generated always as (has_sample = 'no') stored;

comment on column public.tracks.aggregator is
  'Distributor of record: distrokid | tunecore | orchard | open. OPEN = unknown/split — a DistroKid miss is not unreleased.';
comment on column public.tracks.genre_stamp is
  'Operator genre stamp. Meditate is hip_hop_rap only. house_electronic is reserved for the three-title house pool.';
comment on column public.tracks.has_sample is
  'yes | no | unknown. sync_eligible is generated from this (true only when no).';
comment on column public.tracks.sync_eligible is
  'Generated: true only when has_sample = no. Never write this column.';
comment on column public.tracks.is_month1_sync_default is
  'Month-1 sync default song. Only Meditate is seeded true.';
comment on column public.tracks.isrc is
  'Operator-only. Never expose on public/unauthenticated pages. Seed leaves this NULL.';

create unique index if not exists tracks_one_month1_sync_default
  on public.tracks (is_month1_sync_default)
  where is_month1_sync_default;

-- ---------------------------------------------------------------------------
-- 2. Music supervisor / music manager roster (daily input)
-- ---------------------------------------------------------------------------
create table if not exists public.music_supervisors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  email       text,
  notes       text,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists music_supervisors_updated_idx
  on public.music_supervisors (updated_at desc);
create unique index if not exists music_supervisors_email_lower_unique
  on public.music_supervisors (lower(email))
  where email is not null and length(trim(email)) > 0;

alter table public.music_supervisors enable row level security;

drop policy if exists "Deny anon on music_supervisors" on public.music_supervisors;
create policy "Deny anon on music_supervisors"
  on public.music_supervisors for all to anon using (false);

drop policy if exists "Authenticated read music_supervisors" on public.music_supervisors;
create policy "Authenticated read music_supervisors"
  on public.music_supervisors for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Licensing pitch log — same shape as playlist pitch_log
--    who was pitched, when, whether they responded.
--    STARTS EMPTY. No licenses exist; none are in the pipeline.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_pitch_log (
  id              uuid primary key default gen_random_uuid(),
  supervisor_id   uuid references public.music_supervisors(id) on delete set null,
  contact_name    text not null,
  contact_email   text,
  company         text,
  track_id        uuid references public.tracks(id) on delete set null,
  track_name      text not null,
  pitched_at      timestamptz not null default now(),
  status          text not null default 'sent',
  reply_received  boolean not null default false,
  placed          boolean not null default false,
  response_status text not null default 'awaiting',
  response_notes  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint licensing_pitch_log_response_chk
    check (response_status in ('awaiting', 'replied', 'licensed', 'declined'))
);
create index if not exists licensing_pitch_log_pitched_idx
  on public.licensing_pitch_log (pitched_at desc);
create index if not exists licensing_pitch_log_track_idx
  on public.licensing_pitch_log (track_name);
create index if not exists licensing_pitch_log_supervisor_idx
  on public.licensing_pitch_log (supervisor_id);

alter table public.licensing_pitch_log enable row level security;

drop policy if exists "Deny anon on licensing_pitch_log" on public.licensing_pitch_log;
create policy "Deny anon on licensing_pitch_log"
  on public.licensing_pitch_log for all to anon using (false);

drop policy if exists "Authenticated read licensing_pitch_log" on public.licensing_pitch_log;
create policy "Authenticated read licensing_pitch_log"
  on public.licensing_pitch_log for select to authenticated using (true);

comment on table public.licensing_pitch_log is
  'Operator licensing pitches. Mirrors pitch_log (who / when / response). Starts empty.';

-- ---------------------------------------------------------------------------
-- 4. Title-only catalog seed (no ISRCs)
-- ---------------------------------------------------------------------------

-- Meditate: Hip-Hop/Rap, no sample, month-1 default. Do not touch short_pitch
-- (AGH-001 already corrected house mis-stamp). Do not write ISRC.
update public.tracks
set is_month1_sync_default = false
where is_month1_sync_default;

insert into public.tracks (name, status, default_tone, aggregator, genre_stamp, has_sample, is_month1_sync_default)
select 'Meditate', 'active', 'warm_personal', 'open', 'hip_hop_rap', 'no', false
where not exists (
  select 1 from public.tracks t where lower(trim(t.name)) = 'meditate'
);

update public.tracks
set genre_stamp = 'hip_hop_rap',
    has_sample = 'no',
    is_month1_sync_default = true
where lower(trim(name)) = 'meditate';

-- House/electronic pool — stamp existing rows; insert titles if missing.
update public.tracks
set genre_stamp = 'house_electronic'
where lower(name) like '%designed for me%'
   or lower(trim(name)) in ('electrilla', 'balenciaga (let me freeze)');

insert into public.tracks (name, status, default_tone, aggregator, genre_stamp, has_sample)
select v.name, 'active', 'warm_personal', 'open', v.genre, v.sample
from (values
  ('Balenciaga (Let Me Freeze)', 'house_electronic', 'unknown'),
  ('Electrilla',                 'house_electronic', 'unknown'),
  ('Designed For Me (Control)',  'house_electronic', 'unknown'),
  ('Neva Too Much Prada',        'unknown',          'yes')
) as v(name, genre, sample)
where not exists (
  select 1 from public.tracks t where lower(trim(t.name)) = lower(v.name)
);

-- Neva Too Much Prada: Splice saxophone sample → not sync-eligible (generated).
update public.tracks
set has_sample = 'yes'
where lower(name) like '%neva too much prada%';

-- ---------------------------------------------------------------------------
-- 5. Public capture: lock EVEN artist URL onto existing runway listen pages.
--    Do not overwrite a non-empty even_url. Do not invent WhatsApp / Channel.
-- ---------------------------------------------------------------------------
update public.smart_links
set metadata = coalesce(metadata, '{}'::jsonb) ||
               jsonb_build_object('even_url', 'https://www.even.biz/artists/fendi-frost'),
    updated_at = now()
where (
    coalesce(metadata->>'spotify_url', '') <> ''
    or coalesce(metadata->>'apple_music_url', '') <> ''
    or coalesce(metadata->>'soundcloud_url', '') <> ''
    or coalesce(metadata->>'youtube_url', '') <> ''
    or coalesce(metadata->>'tidal_url', '') <> ''
  )
  and coalesce(nullif(trim(metadata->>'even_url'), ''), '') = '';

commit;
