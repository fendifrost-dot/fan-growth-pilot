-- Documentation only — run in Lovable SQL Editor
CREATE TABLE IF NOT EXISTS public.social_engagement_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id text REFERENCES public.playlist_targets(playlist_id) ON DELETE SET NULL,
  platform text NOT NULL,
  action text NOT NULL,
  target_url text NOT NULL,
  draft_text text,
  status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  approved_by text,
  performed_at timestamptz,
  performed_by text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_engagement_queue_status ON public.social_engagement_queue (status, created_at DESC);

ALTER TABLE public.social_engagement_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on social_engagement_queue" ON public.social_engagement_queue FOR ALL TO anon USING (false);
CREATE POLICY "Deny authenticated direct on social_engagement_queue" ON public.social_engagement_queue FOR ALL TO authenticated USING (false);
