-- Documentation only — run in Lovable SQL Editor after playlist-research filter deploy

UPDATE public.playlist_targets
   SET is_active = false,
       pitch_status = 'spotify_owned_skip',
       submission_method = 'none'
 WHERE curator_name = 'Spotify'
    OR curator_name ILIKE 'spotify %'
    OR curator_name IN ('Filtr', 'Topsify', 'Digster');
