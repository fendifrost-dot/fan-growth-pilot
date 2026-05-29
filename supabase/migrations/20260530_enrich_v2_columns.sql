-- Documentation only — run in Lovable SQL Editor / migration tool (source of truth: Lovable migration)

ALTER TABLE public.playlist_targets
  ADD COLUMN IF NOT EXISTS curator_linktree text,
  ADD COLUMN IF NOT EXISTS curator_submission_url text,
  ADD COLUMN IF NOT EXISTS curator_submission_dm text,
  ADD COLUMN IF NOT EXISTS curator_submission_note text,
  ADD COLUMN IF NOT EXISTS submission_method text,
  ADD COLUMN IF NOT EXISTS last_enriched_at timestamptz;

-- Add check only on fresh DBs (skip if constraint already exists or legacy values violate):
-- ALTER TABLE public.playlist_targets
--   ADD CONSTRAINT playlist_targets_submission_method_check
--   CHECK (submission_method IS NULL OR submission_method IN ('email','web_form','instagram_dm','none'));

CREATE INDEX IF NOT EXISTS idx_playlist_targets_submission_method
  ON public.playlist_targets (submission_method);

CREATE INDEX IF NOT EXISTS idx_playlist_targets_last_enriched_at
  ON public.playlist_targets (last_enriched_at);
