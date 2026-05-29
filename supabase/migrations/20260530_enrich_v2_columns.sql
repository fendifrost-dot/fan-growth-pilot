-- Documentation only — run in Lovable SQL Editor / migration tool

ALTER TABLE public.playlist_targets
  ADD COLUMN IF NOT EXISTS curator_submission_url text,
  ADD COLUMN IF NOT EXISTS curator_submission_dm text,
  ADD COLUMN IF NOT EXISTS curator_submission_note text,
  ADD COLUMN IF NOT EXISTS last_enriched_at timestamptz;

-- submission_method and curator_linktree may already exist from prior migrations
ALTER TABLE public.playlist_targets
  ADD COLUMN IF NOT EXISTS curator_linktree text,
  ADD COLUMN IF NOT EXISTS submission_method text;

-- Optional check (skip if existing values violate — run manually if needed):
-- ALTER TABLE playlist_targets ADD CONSTRAINT playlist_targets_submission_method_check
--   CHECK (submission_method IS NULL OR submission_method IN ('email','web_form','instagram_dm','none'));

CREATE INDEX IF NOT EXISTS idx_playlist_targets_submission_method
  ON public.playlist_targets (submission_method) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_playlist_targets_last_enriched_at
  ON public.playlist_targets (last_enriched_at DESC) WHERE is_active = true;
