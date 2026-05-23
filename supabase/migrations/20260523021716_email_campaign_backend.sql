-- =====================================================================
-- Email campaign backend (RUNWAY MUSIC launch + future campaigns)
-- Tables: email_contacts, email_templates, email_campaigns, email_sends
-- Plus: unsubscribe-by-token RPC + CSV bulk-upsert helper
-- =====================================================================

-- ---------------------------------------------------------------------
-- email_contacts: first-party supporter list (~750 to start)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  first_name        text,
  last_name         text,
  phone             text,
  source            text,                          -- e.g. 'mailchimp_2026_export', 'manychat', 'manual'
  tags              text[] DEFAULT ARRAY[]::text[],
  subscribed        boolean NOT NULL DEFAULT true,
  unsubscribed_at   timestamptz,
  unsubscribe_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  last_sent_at      timestamptz,
  last_opened_at    timestamptz,                   -- reserved for Resend webhook
  last_clicked_at   timestamptz,                   -- reserved for Resend webhook
  engagement_score  numeric DEFAULT 0,             -- reserved; updated by future job
  metadata          jsonb DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_contacts_lower_email_uidx
  ON public.email_contacts (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS email_contacts_unsubscribe_token_uidx
  ON public.email_contacts (unsubscribe_token);

CREATE INDEX IF NOT EXISTS email_contacts_subscribed_idx
  ON public.email_contacts (subscribed) WHERE subscribed = true;

CREATE INDEX IF NOT EXISTS email_contacts_source_idx
  ON public.email_contacts (source);

CREATE INDEX IF NOT EXISTS email_contacts_tags_gin
  ON public.email_contacts USING gin (tags);

-- ---------------------------------------------------------------------
-- email_templates
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  subject     text NOT NULL,
  html_body   text NOT NULL,
  text_body   text NOT NULL,
  preheader   text,
  variables   text[] DEFAULT ARRAY['first_name']::text[],
  metadata    jsonb DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- email_campaigns
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  template_id     uuid REFERENCES public.email_templates(id) ON DELETE RESTRICT,
  from_email      text NOT NULL DEFAULT 'studio@fendifrost.com',
  from_name       text NOT NULL DEFAULT 'Fendi Frost',
  reply_to        text DEFAULT 'studio@fendifrost.com',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','paused','completed','archived')),
  audience_filter jsonb DEFAULT '{"subscribed": true}'::jsonb,
  total_sent      integer NOT NULL DEFAULT 0,
  total_failed    integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

-- ---------------------------------------------------------------------
-- email_sends: truth-layer log for every Resend API call
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_sends (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  contact_id         uuid REFERENCES public.email_contacts(id) ON DELETE SET NULL,
  recipient_email    text NOT NULL,
  status             text NOT NULL CHECK (status IN ('queued','sent','failed','skipped')),
  resend_message_id  text,
  error_message      text,
  test_send          boolean NOT NULL DEFAULT false,
  batch_label        text,
  metadata           jsonb DEFAULT '{}'::jsonb,
  sent_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_sends_campaign_contact_real_uidx
  ON public.email_sends (campaign_id, contact_id)
  WHERE test_send = false AND status = 'sent';

CREATE INDEX IF NOT EXISTS email_sends_campaign_status_idx
  ON public.email_sends (campaign_id, status, sent_at DESC);

CREATE INDEX IF NOT EXISTS email_sends_recipient_idx
  ON public.email_sends (lower(recipient_email));

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS email_contacts_updated  ON public.email_contacts;
DROP TRIGGER IF EXISTS email_templates_updated ON public.email_templates;
DROP TRIGGER IF EXISTS email_campaigns_updated ON public.email_campaigns;

CREATE TRIGGER email_contacts_updated  BEFORE UPDATE ON public.email_contacts  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER email_templates_updated BEFORE UPDATE ON public.email_templates FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER email_campaigns_updated BEFORE UPDATE ON public.email_campaigns FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------
-- Unsubscribe RPC
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unsubscribe_by_token(p_token text)
RETURNS TABLE(email text, already_unsubscribed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email       text;
  v_was_already boolean;
BEGIN
  SELECT c.email, NOT c.subscribed
    INTO v_email, v_was_already
  FROM public.email_contacts c
  WHERE c.unsubscribe_token = p_token
  LIMIT 1;

  IF v_email IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.email_contacts
     SET subscribed = false,
         unsubscribed_at = COALESCE(unsubscribed_at, now())
   WHERE unsubscribe_token = p_token;

  RETURN QUERY SELECT v_email, v_was_already;
END $$;

REVOKE ALL ON FUNCTION public.unsubscribe_by_token(text) FROM public;
GRANT EXECUTE ON FUNCTION public.unsubscribe_by_token(text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Bulk CSV upsert
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_email_contacts(p_rows jsonb)
RETURNS TABLE(inserted_count integer, updated_count integer, skipped_count integer, total integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_skipped  integer := 0;
  v_total    integer := 0;
  rec        jsonb;
  v_email    text;
  v_existing uuid;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_total := v_total + 1;
    v_email := lower(trim(rec->>'email'));

    IF v_email IS NULL OR v_email = '' OR v_email NOT LIKE '%_@_%.__%' THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT id INTO v_existing FROM public.email_contacts WHERE lower(email) = v_email LIMIT 1;

    IF v_existing IS NULL THEN
      INSERT INTO public.email_contacts (email, first_name, last_name, phone, source, tags)
      VALUES (
        v_email,
        NULLIF(trim(rec->>'first_name'), ''),
        NULLIF(trim(rec->>'last_name'),  ''),
        NULLIF(trim(rec->>'phone'),      ''),
        NULLIF(trim(rec->>'source'),     ''),
        CASE WHEN rec ? 'tags' AND jsonb_typeof(rec->'tags') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(rec->'tags'))
             ELSE ARRAY[]::text[] END
      );
      v_inserted := v_inserted + 1;
    ELSE
      UPDATE public.email_contacts
         SET first_name = COALESCE(NULLIF(trim(rec->>'first_name'), ''), first_name),
             last_name  = COALESCE(NULLIF(trim(rec->>'last_name'),  ''), last_name),
             phone      = COALESCE(NULLIF(trim(rec->>'phone'),      ''), phone),
             source     = COALESCE(source, NULLIF(trim(rec->>'source'), '')),
             tags       = CASE WHEN rec ? 'tags' AND jsonb_typeof(rec->'tags') = 'array'
                               THEN (SELECT array_agg(DISTINCT x)
                                       FROM unnest(tags || ARRAY(SELECT jsonb_array_elements_text(rec->'tags'))) AS x)
                               ELSE tags END
       WHERE id = v_existing;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_updated, v_skipped, v_total;
END $$;

REVOKE ALL ON FUNCTION public.upsert_email_contacts(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_email_contacts(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE public.email_contacts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_sends     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth full access contacts"  ON public.email_contacts;
DROP POLICY IF EXISTS "auth full access templates" ON public.email_templates;
DROP POLICY IF EXISTS "auth full access campaigns" ON public.email_campaigns;
DROP POLICY IF EXISTS "auth full access sends"     ON public.email_sends;

CREATE POLICY "auth full access contacts"  ON public.email_contacts  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth full access templates" ON public.email_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth full access campaigns" ON public.email_campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth full access sends"     ON public.email_sends     FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- Stats view
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.email_campaign_stats AS
SELECT
  c.id,
  c.name,
  c.slug,
  c.status,
  c.from_email,
  c.total_sent,
  c.total_failed,
  COUNT(s.*) FILTER (WHERE s.status = 'sent'   AND s.test_send = false) AS real_sent,
  COUNT(s.*) FILTER (WHERE s.status = 'failed' AND s.test_send = false) AS real_failed,
  COUNT(s.*) FILTER (WHERE s.test_send = true)                          AS test_sends,
  MAX(s.sent_at)                                                        AS last_send_at,
  c.created_at,
  c.started_at,
  c.completed_at
FROM public.email_campaigns c
LEFT JOIN public.email_sends s ON s.campaign_id = c.id
GROUP BY c.id;

GRANT SELECT ON public.email_campaign_stats TO authenticated, service_role;

COMMENT ON TABLE public.email_contacts  IS 'First-party supporter list. Lowercase email canonical. unsubscribe_token gates one-click unsubscribe.';
COMMENT ON TABLE public.email_templates IS 'Reusable email bodies. {{first_name}} and {{unsubscribe_url}} are merged at send time.';
COMMENT ON TABLE public.email_campaigns IS 'A configured send. status: draft -> sending -> completed.';
COMMENT ON TABLE public.email_sends     IS 'Truth layer for every send attempt. One row per Resend API call.';
