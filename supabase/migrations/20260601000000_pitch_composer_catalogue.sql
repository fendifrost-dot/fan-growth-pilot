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

-- Tracks: Fendi's song catalogue
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

-- track <-> category (max 5 enforced in app, not DB)
create table public.track_categories (
  track_id uuid not null references public.tracks(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (track_id, category_id)
);
create index track_categories_category_idx on public.track_categories(category_id);

-- playlist <-> category (max 5 enforced in app, not DB)
create table public.playlist_categories (
  playlist_id text not null references public.playlist_targets(playlist_id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  primary key (playlist_id, category_id)
);
create index playlist_categories_category_idx on public.playlist_categories(category_id);

-- Explicit platform on playlist_targets (backfilled from playlist_id prefix)
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

-- Track + tone + RLS: assume single-artist app, gate by ARTIST_USER_ID env on backend (existing pattern).
alter table public.tracks enable row level security;
alter table public.categories enable row level security;
alter table public.track_categories enable row level security;
alter table public.playlist_categories enable row level security;

-- Service role bypass is already in place via existing edge functions; add a read policy for authenticated users so the UI can read directly.
create policy "Authenticated read tracks" on public.tracks for select to authenticated using (true);
create policy "Authenticated read categories" on public.categories for select to authenticated using (true);
create policy "Authenticated read track_categories" on public.track_categories for select to authenticated using (true);
create policy "Authenticated read playlist_categories" on public.playlist_categories for select to authenticated using (true);

-- Write policies stay closed; all writes go through edge functions using service role.
