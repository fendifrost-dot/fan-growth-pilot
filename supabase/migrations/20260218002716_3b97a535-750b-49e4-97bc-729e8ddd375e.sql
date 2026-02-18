
-- 1. Add counter columns
ALTER TABLE public.smart_links
ADD COLUMN IF NOT EXISTS cta_click_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS email_submit_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS accordion_open_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS video_play_count integer NOT NULL DEFAULT 0;

-- 2. RPC: increment_cta_click
CREATE OR REPLACE FUNCTION public.increment_cta_click(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.smart_links
  SET cta_click_count = cta_click_count + 1,
      updated_at = now()
  WHERE id = link_id AND is_active = true;
END;
$$;

-- 3. RPC: increment_accordion_open
CREATE OR REPLACE FUNCTION public.increment_accordion_open(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.smart_links
  SET accordion_open_count = accordion_open_count + 1,
      updated_at = now()
  WHERE id = link_id AND is_active = true;
END;
$$;

-- 4. RPC: increment_email_submit
CREATE OR REPLACE FUNCTION public.increment_email_submit(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.smart_links
  SET email_submit_count = email_submit_count + 1,
      updated_at = now()
  WHERE id = link_id AND is_active = true;
END;
$$;

-- 5. RPC: increment_video_play
CREATE OR REPLACE FUNCTION public.increment_video_play(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.smart_links
  SET video_play_count = video_play_count + 1,
      updated_at = now()
  WHERE id = link_id AND is_active = true;
END;
$$;

-- 6. REVOKE default public execute, GRANT only to anon + authenticated
REVOKE ALL ON FUNCTION public.increment_cta_click(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_cta_click(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.increment_accordion_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_accordion_open(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.increment_email_submit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_email_submit(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.increment_video_play(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_video_play(uuid) TO anon, authenticated;
