-- IG curator relationship roster + structured DM brief fields (Lovable SQL Editor)
-- Tracks who Fendi follows / who follows back — required for mutual-only outreach.

CREATE TABLE IF NOT EXISTS public.instagram_curator_roster (
  ig_handle           text PRIMARY KEY,
  display_name        text,
  follows_me          boolean NOT NULL DEFAULT false,
  i_follow            boolean NOT NULL DEFAULT false,
  is_mutual           boolean GENERATED ALWAYS AS (follows_me AND i_follow) STORED,
  relationship_notes  text,
  last_verified_at    timestamptz,
  source              text DEFAULT 'manual',
  metadata            jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ig_roster_mutual ON public.instagram_curator_roster (is_mutual) WHERE is_mutual = true;

ALTER TABLE public.instagram_curator_roster ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on instagram_curator_roster" ON public.instagram_curator_roster FOR ALL TO anon USING (false);

ALTER TABLE public.social_engagement_queue
  ADD COLUMN IF NOT EXISTS ig_handle text,
  ADD COLUMN IF NOT EXISTS dm_ref text,
  ADD COLUMN IF NOT EXISTS operator_brief text;

CREATE INDEX IF NOT EXISTS idx_social_queue_dm_ref ON public.social_engagement_queue (dm_ref) WHERE dm_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_queue_ig_handle ON public.social_engagement_queue (ig_handle);
