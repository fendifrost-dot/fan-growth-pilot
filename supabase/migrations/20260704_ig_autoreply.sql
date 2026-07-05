-- Documentation only — run in Lovable SQL Editor (paste; do not type UPDATE).

CREATE TABLE IF NOT EXISTS public.ig_autoreply_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type  text NOT NULL,
  keyword       text,
  smartlink_url text NOT NULL,
  reply_template text NOT NULL,
  album_slug    text,
  active        boolean NOT NULL DEFAULT true,
  priority      int NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ig_autoreply_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on ig_autoreply_rules" ON public.ig_autoreply_rules FOR ALL TO anon USING (false);

CREATE TABLE IF NOT EXISTS public.ig_autoreply_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_user_id    text NOT NULL,
  ig_handle     text,
  trigger_type  text NOT NULL,
  inbound_text  text,
  matched_rule  uuid REFERENCES public.ig_autoreply_rules(id),
  reply_sent    boolean NOT NULL DEFAULT false,
  reply_text    text,
  skip_reason   text,
  event_id      uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ig_autoreply_log_user_time ON public.ig_autoreply_log (ig_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ig_autoreply_log_reply_sent_time ON public.ig_autoreply_log (reply_sent, created_at DESC);

ALTER TABLE public.ig_autoreply_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny anon on ig_autoreply_log" ON public.ig_autoreply_log FOR ALL TO anon USING (false);

-- Seed: one catch-all DM rule per released album (keyword = album slug).
INSERT INTO public.ig_autoreply_rules (trigger_type, keyword, smartlink_url, reply_template, album_slug, priority)
SELECT * FROM (VALUES
  ('dm', 'runway', 'https://links.fendifrost.com/runwaymusic', 'here you go 🎵 {{link}}', 'runwaymusic', 10),
  ('dm', 'chakra', 'https://links.fendifrost.com/heartchakra', 'here you go 🎵 {{link}}', 'heartchakra', 20),
  ('dm', 'nutrition', 'https://links.fendifrost.com/nutrition', 'here you go 🎵 {{link}}', 'nutrition', 30),
  ('story_reply', NULL::text, 'https://links.fendifrost.com/runwaymusic', 'appreciate you 🐻‍❄️ latest drop: {{link}}', 'runwaymusic', 100),
  ('comment', NULL::text, 'https://links.fendifrost.com/runwaymusic', 'appreciate the love 🐻‍❄️ here''s the link: {{link}}', 'runwaymusic', 100)
) AS v(trigger_type, keyword, smartlink_url, reply_template, album_slug, priority)
WHERE NOT EXISTS (SELECT 1 FROM public.ig_autoreply_rules LIMIT 1);
