
-- Fendi FanFuel Hub playlist catalog migration (additive + FK-safe)

-- Ensure unique constraint on playlist_id for FK references
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'playlist_targets_playlist_id_key'
  ) THEN
    ALTER TABLE playlist_targets
      ADD CONSTRAINT playlist_targets_playlist_id_key UNIQUE (playlist_id);
  END IF;
END $$;

-- Add new columns to playlist_targets
ALTER TABLE playlist_targets
  ADD COLUMN IF NOT EXISTS submission_url TEXT,
  ADD COLUMN IF NOT EXISTS submission_method TEXT,
  ADD COLUMN IF NOT EXISTS tier SMALLINT,
  ADD COLUMN IF NOT EXISTS whitelist_status BOOLEAN,
  ADD COLUMN IF NOT EXISTS legitimacy_score INTEGER,
  ADD COLUMN IF NOT EXISTS vibe_tags JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS similar_artists JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_pitched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pitch_count INTEGER DEFAULT 0 NOT NULL;

COMMENT ON COLUMN playlist_targets.submission_method IS 'email | web_form | google_form | submithub | groover | dailyplaylists | indiemono | soundplate | playlistpartner | spotify_dm | instagram_dm | distributor_pitch | algorithmic | other';
COMMENT ON COLUMN playlist_targets.tier IS '1 whitelist, 2 clean, 3 flagged';

-- Backfill nulls
UPDATE playlist_targets SET is_active = true WHERE is_active IS NULL;
UPDATE playlist_targets SET pitch_count = 0 WHERE pitch_count IS NULL;
UPDATE playlist_targets SET vibe_tags = '[]'::jsonb WHERE vibe_tags IS NULL;
UPDATE playlist_targets SET similar_artists = '[]'::jsonb WHERE similar_artists IS NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_playlist_targets_active_tier ON playlist_targets (is_active, tier) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_playlist_targets_fraud_verdict ON playlist_targets (fraud_verdict) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_playlist_targets_followers ON playlist_targets (follower_count DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_playlist_targets_vibe_tags_gin ON playlist_targets USING GIN (vibe_tags jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_playlist_targets_similar_artists_gin ON playlist_targets USING GIN (similar_artists jsonb_path_ops);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION set_playlist_targets_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_playlist_targets_updated_at ON playlist_targets;
CREATE TRIGGER trg_playlist_targets_updated_at BEFORE UPDATE ON playlist_targets FOR EACH ROW EXECUTE PROCEDURE set_playlist_targets_updated_at();

-- pitch_log: add missing columns if table exists, or handle conflicts
ALTER TABLE pitch_log
  ADD COLUMN IF NOT EXISTS method TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS response_notes TEXT,
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pitched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pitch_log_track_cooldown ON pitch_log (track_name, cooldown_until);
CREATE INDEX IF NOT EXISTS idx_pitch_log_playlist_track ON pitch_log (playlist_id, track_name);

-- follower_snapshots table
CREATE TABLE IF NOT EXISTS follower_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id TEXT NOT NULL REFERENCES playlist_targets(playlist_id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  follower_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'spotify_api',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (playlist_id, snapshot_date, source)
);

CREATE INDEX IF NOT EXISTS idx_follower_snapshots_playlist_date ON follower_snapshots (playlist_id, snapshot_date DESC);

-- artist_config table
CREATE TABLE IF NOT EXISTS artist_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO artist_config (key, value) VALUES
  ('artist_name', '"Fendi Frost"'),
  ('similar_artists', '["Larry June","Dom Kennedy","Freddie Gibbs","Stove God Cooks","Boldy James","Nipsey Hussle","Wale","J Cole","G Herbo","Young Pappy","Pirate Reem","Joel Q"]'),
  ('vibe_keywords', '["chill trap","conscious","spiritual","west coast","holistic","meditation","808s","native flute"]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
