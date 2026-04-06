
-- Enable RLS on playlist_targets and pitch_log
-- These tables are accessed exclusively by Edge Functions using SUPABASE_SERVICE_ROLE_KEY (which bypasses RLS)

ALTER TABLE public.playlist_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pitch_log ENABLE ROW LEVEL SECURITY;

-- Explicitly allow service_role full access (defensive — service_role bypasses RLS by default, but documents intent)
CREATE POLICY "Service role full access on playlist_targets"
  ON public.playlist_targets FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on pitch_log"
  ON public.pitch_log FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Deny anon access explicitly
CREATE POLICY "Deny anonymous access to playlist_targets"
  ON public.playlist_targets FOR ALL
  TO anon
  USING (false);

CREATE POLICY "Deny anonymous access to pitch_log"
  ON public.pitch_log FOR ALL
  TO anon
  USING (false);

-- Deny authenticated direct access (these tables have no user_id — all access goes through Edge Functions)
CREATE POLICY "Deny authenticated direct access to playlist_targets"
  ON public.playlist_targets FOR ALL
  TO authenticated
  USING (false);

CREATE POLICY "Deny authenticated direct access to pitch_log"
  ON public.pitch_log FOR ALL
  TO authenticated
  USING (false);
