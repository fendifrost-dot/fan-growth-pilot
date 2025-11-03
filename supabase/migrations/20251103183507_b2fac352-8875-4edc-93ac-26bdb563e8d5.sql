-- Deny anonymous access to profiles table
CREATE POLICY "Deny anonymous access to profiles"
ON public.profiles
FOR ALL
TO anon
USING (false);

-- Deny anonymous access to fan_data table (contains PII)
CREATE POLICY "Deny anonymous access to fan_data"
ON public.fan_data
FOR ALL
TO anon
USING (false);

-- Deny anonymous access to platform_connections (contains OAuth tokens)
CREATE POLICY "Deny anonymous access to platform_connections"
ON public.platform_connections
FOR ALL
TO anon
USING (false);

-- Deny anonymous SELECT/UPDATE/DELETE on link_analytics
CREATE POLICY "Deny anonymous SELECT on link_analytics"
ON public.link_analytics
FOR SELECT
TO anon
USING (false);

CREATE POLICY "Deny anonymous UPDATE on link_analytics"
ON public.link_analytics
FOR UPDATE
TO anon
USING (false);

CREATE POLICY "Deny anonymous DELETE on link_analytics"
ON public.link_analytics
FOR DELETE
TO anon
USING (false);