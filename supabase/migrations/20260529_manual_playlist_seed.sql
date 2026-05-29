-- Documentation only — run in Lovable SQL Editor
-- Copy one block per playlist. Get playlist_id from open.spotify.com/playlist/XXXX

-- Example (replace YOUR_PLAYLIST_ID, names, and email):
/*
INSERT INTO public.playlist_targets (
  playlist_id, platform, playlist_name, curator_name, curator_email,
  follower_count, track_count, overlap_score, fraud_score, fraud_verdict,
  pitch_status, tier, whitelist_status, vibe_tags, similar_artists,
  submission_method, submission_url, is_active, lane, research_context
) VALUES (
  'spotify:YOUR_PLAYLIST_ID',
  'spotify',
  'Playlist display name',
  'Curator display name',
  NULL,  -- set via /admin Set email, or paste here
  1000, 0, 0, 50, 'safe',
  'not_pitched', 2, false,
  '["kaytranada","deep_house","groove"]'::jsonb,
  '["Kaytranada","Channel Tres","SG Lewis"]'::jsonb,
  'email',
  'https://open.spotify.com/playlist/YOUR_PLAYLIST_ID',
  true,
  'deep_house_groove',
  jsonb_build_object('source', 'manual_seed', 'fetched_at', now())
)
ON CONFLICT (playlist_id) DO UPDATE SET
  playlist_name = EXCLUDED.playlist_name,
  lane = EXCLUDED.lane,
  vibe_tags = EXCLUDED.vibe_tags,
  is_active = true,
  updated_at = now();
*/
