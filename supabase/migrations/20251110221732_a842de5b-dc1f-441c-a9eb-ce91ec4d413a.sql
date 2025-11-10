-- Create secure function for anonymous click tracking
CREATE OR REPLACE FUNCTION public.increment_link_clicks(link_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE smart_links 
  SET click_count = click_count + 1,
      updated_at = now()
  WHERE id = link_id AND is_active = true;
END;
$$;

-- Grant execute permission to anonymous and authenticated users
GRANT EXECUTE ON FUNCTION public.increment_link_clicks TO anon, authenticated;