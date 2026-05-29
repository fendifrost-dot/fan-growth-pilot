-- Documentation only — run in Lovable SQL Editor
INSERT INTO public.artist_config (key, value) VALUES
  ('lanes', '{
    "deep_house_groove": {
      "label": "Chicago deep-house influenced melodic rap",
      "references": ["Drake — Passionfruit", "Channel Tres — Joyful Noise", "Kaytranada", "SG Lewis", "Duckwrth"],
      "pitch_angle": "Chicago deep-house influenced melodic rap with a late-night luxury/fashion feel — sits between Drake ''Passionfruit'' and Channel Tres ''Joyful Noise.''",
      "regex_boost": "house|kaytranada|channel\\s*tres|deep\\s*house|garage|club\\s*rap|dance\\s*rap|nu\\s*disco|groove|funk|electronic|indie\\s*dance"
    },
    "edm_club_rap": {
      "label": "EDM rap / club energy",
      "references": ["RUNWAY MUSIC club cuts"],
      "pitch_angle": "Club-ready EDM rap with festival energy — fits late-night rotations.",
      "regex_boost": "edm|festival|club|big\\s*room|tech\\s*house|main\\s*stage|workout|hype"
    },
    "west_coast_conscious": {
      "label": "West-coast conscious / chill",
      "references": ["Larry June", "Dom Kennedy", "Nipsey Hussle"],
      "pitch_angle": "West-coast conscious rap with a chill, spiritual undertone.",
      "regex_boost": "west\\s*coast|larry\\s*june|dom\\s*kennedy|cali|spiritual|conscious"
    }
  }'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO public.artist_config (key, value) VALUES
  ('spotify_track_urls', '{
    "Designed For Me (Control)": "https://rnd.fm/runway-music-hlpad6"
  }'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = public.artist_config.value || EXCLUDED.value, updated_at = now();
