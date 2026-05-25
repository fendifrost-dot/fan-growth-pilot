-- Documentation only — run in Lovable SQL Editor
ALTER TABLE public.pitch_log
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS placement_status text DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS approval_required boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text;

CREATE INDEX IF NOT EXISTS idx_pitch_log_follow_up ON public.pitch_log (follow_up_at)
  WHERE follow_up_at IS NOT NULL AND status = 'sent';
CREATE INDEX IF NOT EXISTS idx_pitch_log_placement ON public.pitch_log (placement_status)
  WHERE placement_status <> 'unknown';
