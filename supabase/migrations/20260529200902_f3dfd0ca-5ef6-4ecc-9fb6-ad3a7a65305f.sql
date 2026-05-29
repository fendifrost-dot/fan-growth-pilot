ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS curator_linktree text;

ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS curator_submission_url text;

ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS curator_submission_dm text;

ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS curator_submission_note text;

ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS submission_method text;

ALTER TABLE public.playlist_targets
ADD COLUMN IF NOT EXISTS last_enriched_at timestamptz;