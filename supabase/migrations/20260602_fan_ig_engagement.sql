-- Documentation only — run in Lovable SQL Editor (paste; do not type UPDATE).

CREATE TABLE IF NOT EXISTS public.instagram_fan_roster (
  ig_handle           text PRIMARY KEY,
  display_name        text,
  follows_me          boolean NOT NULL DEFAULT true,
  i_follow            boolean NOT NULL DEFAULT false,
  ig_user_id          text,
  dm_stage            text NOT NULL DEFAULT 'opener',
  do_not_contact      boolean NOT NULL DEFAULT false,
  relationship_notes  text,
  last_contacted_at   timestamptz,
  metadata            jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fan_roster_follows ON public.instagram_fan_roster (follows_me)
  WHERE follows_me = true AND do_not_contact = false;

ALTER TABLE public.instagram_fan_roster ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on instagram_fan_roster" ON public.instagram_fan_roster FOR ALL TO anon USING (false);

CREATE TABLE IF NOT EXISTS public.fan_engagement_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_handle text NOT NULL REFERENCES public.instagram_fan_roster(ig_handle) ON DELETE CASCADE,
  stage text NOT NULL,
  template_slug text NOT NULL,
  template_body text,
  draft_text text NOT NULL,
  operator_brief text,
  dm_ref text,
  status text NOT NULL DEFAULT 'pending',
  personalization_method text,
  performed_at timestamptz,
  performed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fan_queue_status ON public.fan_engagement_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fan_queue_handle ON public.fan_engagement_queue (ig_handle);

ALTER TABLE public.fan_engagement_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on fan_engagement_queue" ON public.fan_engagement_queue FOR ALL TO anon USING (false);
