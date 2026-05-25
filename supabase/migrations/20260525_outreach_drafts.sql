-- Documentation only — run in Lovable SQL Editor
CREATE TABLE IF NOT EXISTS public.outreach_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id text NOT NULL REFERENCES public.playlist_targets(playlist_id) ON DELETE CASCADE,
  track_name text NOT NULL,
  channel text NOT NULL,
  recipient text,
  subject text,
  body text NOT NULL,
  generated_by text NOT NULL DEFAULT 'auto',
  generated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text,
  sent_at timestamptz,
  pitch_log_id uuid REFERENCES public.pitch_log(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_drafts_status ON public.outreach_drafts (status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_playlist_track ON public.outreach_drafts (playlist_id, track_name);

ALTER TABLE public.outreach_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on outreach_drafts" ON public.outreach_drafts FOR ALL TO anon USING (false);
CREATE POLICY "Deny authenticated direct on outreach_drafts" ON public.outreach_drafts FOR ALL TO authenticated USING (false);

CREATE OR REPLACE FUNCTION set_outreach_drafts_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_outreach_drafts_updated_at ON public.outreach_drafts;
CREATE TRIGGER trg_outreach_drafts_updated_at BEFORE UPDATE ON public.outreach_drafts FOR EACH ROW EXECUTE PROCEDURE set_outreach_drafts_updated_at();
