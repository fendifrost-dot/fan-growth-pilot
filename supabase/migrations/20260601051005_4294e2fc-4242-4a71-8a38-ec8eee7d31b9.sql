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