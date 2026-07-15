-- Seed smart links for "Meditate" and "Designed For Me (Control)".
--
-- The daily submissions job requires a smart link per song to use as the
-- "Stream:" link; neither song had one, so both were being skipped. These rows
-- match the FLAT-metadata shape the live SmartLinkPage reads (metadata.*_url) —
-- exactly like the newer single-track rows (fillingavoid / modestmandeluxe), and
-- NOT the stale metadata.platforms[] array shape that never rendered.
--
-- Owner is inherited from the existing catalogue owner (the 'runway' row) so no
-- profile UUID is hard-coded. Idempotent: re-running refreshes shape without
-- creating duplicates (slug is UNIQUE) and preserves any DSP keys / artwork that
-- resolve-artwork added later (existing metadata wins the merge, then the seed
-- keys are re-applied).
--
-- Spotify-only renders a working link + Spotify button today. To enrich with
-- Apple / Tidal / SoundCloud + cover art, call the resolve-artwork edge function
-- with each new row's { linkId } after applying this migration — Odesli expands
-- the single Spotify URL into the full DSP set.

INSERT INTO public.smart_links (user_id, title, slug, destination_url, theme_preset, is_active, metadata)
VALUES
  (
    (SELECT user_id FROM public.smart_links ORDER BY created_at ASC LIMIT 1),
    'Meditate',
    'meditate',
    'https://open.spotify.com/track/3JIWaAOsjD23DGg9e2XYc8',
    'default',
    true,
    jsonb_build_object(
      'spotify_url',  'https://open.spotify.com/track/3JIWaAOsjD23DGg9e2XYc8',
      'artist_name',  'Fendi Frost',
      'campaignName', 'Meditate'
    )
  ),
  (
    (SELECT user_id FROM public.smart_links ORDER BY created_at ASC LIMIT 1),
    'Designed For Me (Control)',
    'designedforme',
    'https://open.spotify.com/track/7sJxadBp6nw4KaMLiPsiwD',
    'default',
    true,
    jsonb_build_object(
      'spotify_url',  'https://open.spotify.com/track/7sJxadBp6nw4KaMLiPsiwD',
      'artist_name',  'Fendi Frost',
      'campaignName', 'Designed For Me (Control)'
    )
  )
ON CONFLICT (slug) DO UPDATE SET
  destination_url = EXCLUDED.destination_url,
  theme_preset    = EXCLUDED.theme_preset,
  is_active       = true,
  metadata        = COALESCE(public.smart_links.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at      = now();
