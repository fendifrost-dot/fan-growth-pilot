-- Documentation only — run in Lovable SQL Editor (see CURSOR_HANDOFF_PLAYLIST_AGENT.md)
ALTER TABLE public.playlist_targets
  ADD COLUMN IF NOT EXISTS curator_instagram text,
  ADD COLUMN IF NOT EXISTS curator_tiktok text,
  ADD COLUMN IF NOT EXISTS curator_twitter text,
  ADD COLUMN IF NOT EXISTS curator_website text,
  ADD COLUMN IF NOT EXISTS curator_linktree text,
  ADD COLUMN IF NOT EXISTS contact_confidence smallint,
  ADD COLUMN IF NOT EXISTS authenticity_score smallint,
  ADD COLUMN IF NOT EXISTS authenticity_notes text,
  ADD COLUMN IF NOT EXISTS recommended_pitch_angle text,
  ADD COLUMN IF NOT EXISTS why_it_fits text,
  ADD COLUMN IF NOT EXISTS lane text;

COMMENT ON COLUMN public.playlist_targets.lane IS 'Coarse song-lane bucket; informs pitch angle templating. See artist_config.lanes for canonical values.';
COMMENT ON COLUMN public.playlist_targets.contact_confidence IS '1=guessing, 10=verified curator email or DM-confirmed.';
COMMENT ON COLUMN public.playlist_targets.authenticity_score IS 'Distinct from fraud_score. 1=likely fake/farm, 10=verified human curator with real footprint.';

CREATE INDEX IF NOT EXISTS idx_playlist_targets_lane ON public.playlist_targets (lane) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_playlist_targets_authenticity ON public.playlist_targets (authenticity_score DESC) WHERE is_active = true;
