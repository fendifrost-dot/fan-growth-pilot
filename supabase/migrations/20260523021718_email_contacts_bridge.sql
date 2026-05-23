-- =====================================================================
-- Bridge: smart_link_leads + fan_profiles -> email_contacts
--
-- Goal: any email captured ANYWHERE on the platform automatically lands
-- in email_contacts. The runway smart link's email form, future fan_profile
-- writes, future ManyChat/Meta lead syncs — all unified.
--
-- Behavior rules:
-- - INSERT-ON-MISSING only. We NEVER overwrite an existing email_contacts
--   row's subscription state. If someone unsubscribed and later opts back
--   in via a smart link, that's a manual re-subscribe.
-- - tags are unioned (additive) on conflict so we don't lose source info.
-- - first_name from fan_profiles is filled into email_contacts only if
--   email_contacts.first_name is currently null.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: upsert one row into email_contacts from a source signal.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_upsert_email_contact(
  p_email       text,
  p_first_name  text,
  p_source      text,
  p_extra_tags  text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_id    uuid;
BEGIN
  v_email := lower(trim(coalesce(p_email, '')));
  -- Must look like an email
  IF v_email = '' OR v_email NOT LIKE '%_@_%.__%' THEN
    RETURN NULL;
  END IF;

  -- Try fast path: existing row?
  SELECT id INTO v_id FROM public.email_contacts WHERE lower(email) = v_email;
  IF v_id IS NOT NULL THEN
    -- Additive update only — never touches subscribed / unsubscribed_at
    UPDATE public.email_contacts
       SET first_name = COALESCE(first_name, NULLIF(trim(p_first_name), '')),
           source     = COALESCE(source, p_source),
           tags       = (SELECT array_agg(DISTINCT t)
                           FROM unnest(coalesce(tags, ARRAY[]::text[]) || coalesce(p_extra_tags, ARRAY[]::text[])) AS t
                          WHERE t IS NOT NULL AND t <> '')
     WHERE id = v_id;
    RETURN v_id;
  END IF;

  -- New row — defaults to subscribed=true (just opted in)
  INSERT INTO public.email_contacts (email, first_name, source, tags)
  VALUES (
    v_email,
    NULLIF(trim(p_first_name), ''),
    p_source,
    COALESCE(p_extra_tags, ARRAY[]::text[])
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.bridge_upsert_email_contact(text, text, text, text[]) FROM public;
GRANT EXECUTE ON FUNCTION public.bridge_upsert_email_contact(text, text, text, text[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Trigger: smart_link_leads INSERT -> email_contacts
-- Source becomes 'smart_link:<slug>' (resolved from smart_links table).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_smart_link_lead_to_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
BEGIN
  BEGIN
    SELECT slug INTO v_slug FROM public.smart_links WHERE id = NEW.smart_link_id;

    PERFORM public.bridge_upsert_email_contact(
      NEW.email,
      NULL,                                            -- smart_link_leads has no first_name
      'smart_link' || COALESCE(':' || v_slug, ''),
      ARRAY['smart_link']::text[] || CASE WHEN v_slug IS NOT NULL THEN ARRAY[v_slug] ELSE ARRAY[]::text[] END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never break a live smart-link signup if the bridge fails.
    RAISE WARNING 'smart_link_leads -> email_contacts bridge failed for %: %', NEW.email, SQLERRM;
  END;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS smart_link_leads_to_email_contacts ON public.smart_link_leads;
CREATE TRIGGER smart_link_leads_to_email_contacts
AFTER INSERT ON public.smart_link_leads
FOR EACH ROW EXECUTE FUNCTION public.trg_smart_link_lead_to_contact();

-- ---------------------------------------------------------------------
-- Trigger: fan_profiles INSERT OR UPDATE OF email -> email_contacts
-- Source becomes 'fan_profile' or, if first_source is set, 'fan_profile:<first_source>'.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fan_profile_to_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR trim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.bridge_upsert_email_contact(
      NEW.email,
      NULL,
      'fan_profile' || COALESCE(':' || NEW.first_source, ''),
      ARRAY['fan_profile']::text[]
        || CASE WHEN NEW.first_source IS NOT NULL THEN ARRAY[NEW.first_source] ELSE ARRAY[]::text[] END
        || CASE WHEN NEW.first_song   IS NOT NULL THEN ARRAY[NEW.first_song]   ELSE ARRAY[]::text[] END
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never break a fan_profile write if the bridge fails.
    RAISE WARNING 'fan_profiles -> email_contacts bridge failed for %: %', NEW.email, SQLERRM;
  END;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS fan_profiles_to_email_contacts ON public.fan_profiles;
CREATE TRIGGER fan_profiles_to_email_contacts
AFTER INSERT OR UPDATE OF email ON public.fan_profiles
FOR EACH ROW EXECUTE FUNCTION public.trg_fan_profile_to_contact();

-- =====================================================================
-- BACKFILL: every existing email lands in email_contacts (idempotent)
-- =====================================================================

-- 1) From smart_link_leads (group by lowercased email, keep most recent)
INSERT INTO public.email_contacts (email, source, tags)
SELECT
  lower(trim(sll.email)) AS email,
  'smart_link' || COALESCE(':' || sl.slug, '') AS source,
  ARRAY['smart_link']::text[]
    || CASE WHEN sl.slug IS NOT NULL THEN ARRAY[sl.slug] ELSE ARRAY[]::text[] END AS tags
FROM public.smart_link_leads sll
LEFT JOIN public.smart_links sl ON sl.id = sll.smart_link_id
WHERE sll.email IS NOT NULL
  AND trim(sll.email) <> ''
  AND lower(trim(sll.email)) LIKE '%_@_%.__%'
ON CONFLICT (lower(email)) DO UPDATE
  SET source = COALESCE(email_contacts.source, EXCLUDED.source),
      tags   = (SELECT array_agg(DISTINCT t)
                  FROM unnest(email_contacts.tags || EXCLUDED.tags) AS t
                 WHERE t IS NOT NULL AND t <> '');

-- 2) From fan_profiles
INSERT INTO public.email_contacts (email, source, tags)
SELECT
  lower(trim(fp.email)) AS email,
  'fan_profile' || COALESCE(':' || fp.first_source, '') AS source,
  ARRAY['fan_profile']::text[]
    || CASE WHEN fp.first_source IS NOT NULL THEN ARRAY[fp.first_source] ELSE ARRAY[]::text[] END
    || CASE WHEN fp.first_song   IS NOT NULL THEN ARRAY[fp.first_song]   ELSE ARRAY[]::text[] END AS tags
FROM public.fan_profiles fp
WHERE fp.email IS NOT NULL
  AND trim(fp.email) <> ''
  AND lower(trim(fp.email)) LIKE '%_@_%.__%'
ON CONFLICT (lower(email)) DO UPDATE
  SET source = COALESCE(email_contacts.source, EXCLUDED.source),
      tags   = (SELECT array_agg(DISTINCT t)
                  FROM unnest(email_contacts.tags || EXCLUDED.tags) AS t
                 WHERE t IS NOT NULL AND t <> '');

-- ---------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------
COMMENT ON FUNCTION public.bridge_upsert_email_contact(text, text, text, text[]) IS
  'Insert-or-additive-update an email into email_contacts. NEVER touches subscribed/unsubscribed_at — re-subscribing must be explicit.';
COMMENT ON TRIGGER smart_link_leads_to_email_contacts ON public.smart_link_leads IS
  'Auto-promote new smart-link signups into the email_contacts list (source=smart_link:<slug>).';
COMMENT ON TRIGGER fan_profiles_to_email_contacts    ON public.fan_profiles IS
  'Auto-promote fan_profile rows with an email into email_contacts (source=fan_profile[:first_source]).';
