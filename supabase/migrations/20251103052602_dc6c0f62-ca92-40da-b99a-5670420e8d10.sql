-- Add pixel_id column to platform_connections table for Facebook Pixel tracking
ALTER TABLE public.platform_connections
ADD COLUMN pixel_id text;