-- Categories: shared tag bag for tracks and playlists
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  family text not null default 'genre' check (family in ('genre','vibe','mood')),
  description text,
  created_at timestamptz not null default now()
);
create index categories_family_idx on public.categories(family);

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  isrc text,
  spotify_url text,
  apple_music_url text,
  soundcloud_url text,
  status text not null default 'active' check (status in ('active','archived','unreleased')),
  release_date date,
  default_tone text not null default 'warm_personal'
    check (default_tone in ('warm_personal','casual_friendly','business_formal','hyped_energetic')),
  short_pitch text,
  pitch_angle text,
  reference_artists text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tracks_name_lower_unique on public.tracks(lower(name));
create index tracks_isrc_idx on public.tracks(isrc) where isrc is not null;
create index tracks_status_idx on public.tracks(status);

create table public.track_categories (
  track_id uuid not null references public.tracks(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (track_id, category_id)
);
create index track_categories_category_idx on public.track_categories(category_id);

create table public.playlist_categories (
  playlist_id text not null references public.playlist_targets(playlist_id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (playlist_id, category_id)
);
create index playlist_categories_category_idx on public.playlist_categories(category_id);

alter table public.playlist_targets
  add column if not exists platform text;

update public.playlist_targets set platform = case
  when playlist_id like 'spotify:%' then 'spotify'
  when playlist_id like 'apple_music:%' then 'apple_music'
  when playlist_id like 'soundcloud:%' then 'soundcloud'
  when playlist_id like 'youtube:%' then 'youtube'
  when playlist_id like 'blog:%' then 'blog'
  else 'spotify'
end where platform is null;

alter table public.playlist_targets
  alter column platform set default 'spotify',
  alter column platform set not null;
create index playlist_targets_platform_idx on public.playlist_targets(platform);

alter table public.tracks enable row level security;
alter table public.categories enable row level security;
alter table public.track_categories enable row level security;
alter table public.playlist_categories enable row level security;

create policy "Authenticated read tracks" on public.tracks for select to authenticated using (true);
create policy "Authenticated read categories" on public.categories for select to authenticated using (true);
create policy "Authenticated read track_categories" on public.track_categories for select to authenticated using (true);
create policy "Authenticated read playlist_categories" on public.playlist_categories for select to authenticated using (true);

grant select on public.tracks to authenticated;
grant select on public.categories to authenticated;
grant select on public.track_categories to authenticated;
grant select on public.playlist_categories to authenticated;
grant all on public.tracks to service_role;
grant all on public.categories to service_role;
grant all on public.track_categories to service_role;
grant all on public.playlist_categories to service_role;

insert into public.categories(slug, label, family) values
  ('melodic_rap', 'Melodic Rap', 'genre'),
  ('chill_rap', 'Chill Rap', 'genre'),
  ('conscious_rap', 'Conscious Rap', 'genre'),
  ('drill', 'Drill', 'genre'),
  ('chicago_drill', 'Chicago Drill', 'genre'),
  ('west_coast_rap', 'West Coast Rap', 'genre'),
  ('trap', 'Trap', 'genre'),
  ('trap_soul', 'Trap Soul', 'genre'),
  ('rnb', 'R&B', 'genre'),
  ('deep_house_groove', 'Deep House Groove', 'genre'),
  ('edm_festival', 'EDM Festival', 'genre'),
  ('big_room_house', 'Big Room House', 'genre'),
  ('lo_fi', 'Lo-Fi', 'genre'),
  ('late_night', 'Late Night', 'vibe'),
  ('luxury', 'Luxury', 'vibe'),
  ('workout', 'Workout', 'vibe'),
  ('driving', 'Driving / Cruising', 'vibe'),
  ('summer', 'Summer', 'vibe'),
  ('introspective', 'Introspective', 'vibe')
on conflict (slug) do nothing;

do $$
declare
  cfg jsonb;
  k text;
  v text;
  tid uuid;
  cat_id uuid;
begin
  select value into cfg from public.artist_config where key = 'spotify_track_urls';
  if cfg is null then return; end if;
  for k, v in select * from jsonb_each_text(cfg) loop
    insert into public.tracks(name, spotify_url, status, default_tone, short_pitch)
    values (k, nullif(v,''), 'active', 'warm_personal', null)
    on conflict (lower(name)) do update set spotify_url = excluded.spotify_url
    returning id into tid;
    select id into cat_id from public.categories where slug = 'deep_house_groove' limit 1;
    if tid is not null and cat_id is not null and lower(k) like '%designed for me%' then
      insert into public.track_categories(track_id, category_id) values (tid, cat_id) on conflict do nothing;
    end if;
  end loop;
end$$;

insert into public.playlist_categories (playlist_id, category_id)
select pt.playlist_id, c.id
from public.playlist_targets pt
join public.categories c on c.slug = pt.lane
where pt.lane is not null and pt.lane <> ''
on conflict do nothing;