-- PlaylistDock identifies a playlist with ?slug=. agh_curator_form_key used to
-- drop the query string, so every PlaylistDock playlist collapsed to playlist.php
-- and shared one cooldown. Keep slug for playlistdock.com only. Other sites still
-- ignore tracking queries. Does not rewrite stored rows.
begin;

create or replace function public.agh_curator_form_key(p_url text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := lower(trim(coalesce(p_url, '')));
  hostpath text;
  query text;
  slug text;
begin
  if v = '' then
    return null;
  end if;
  v := regexp_replace(v, '^https?://(www\.)?', '');
  hostpath := regexp_replace(split_part(split_part(v, '?', 1), '#', 1), '/+$', '');
  query := split_part(split_part(v, '?', 2), '#', 1);
  if hostpath ~ '(^|\.)playlistdock\.com(/|$)' and query <> '' then
    slug := substring(query from '(?:^|&)slug=([^&]*)');
    if slug is not null and slug <> '' then
      return nullif(hostpath || '?slug=' || slug, '');
    end if;
  end if;
  return nullif(hostpath, '');
end;
$$;

revoke all on function public.agh_curator_form_key(text) from public, anon, authenticated;
grant execute on function public.agh_curator_form_key(text) to service_role;

commit;
