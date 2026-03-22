
-- Enable RLS on new tables
ALTER TABLE follower_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE artist_config ENABLE ROW LEVEL SECURITY;

-- follower_snapshots: allow service role (edge functions) full access, block anon/authenticated direct access
CREATE POLICY "Allow all for service role on follower_snapshots"
  ON follower_snapshots FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- artist_config: read-only for authenticated, full access for service role
CREATE POLICY "Anyone can read artist_config"
  ON artist_config FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow all for service role on artist_config"
  ON artist_config FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Fix search_path on the new function
CREATE OR REPLACE FUNCTION set_playlist_targets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;
