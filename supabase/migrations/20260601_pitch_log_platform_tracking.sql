-- Documentation only — run in Lovable SQL Editor before deploying edge functions.
ALTER TABLE public.pitch_log ADD COLUMN IF NOT EXISTS platform_name text;
ALTER TABLE public.pitch_log ADD COLUMN IF NOT EXISTS platform_pitch_id text;
ALTER TABLE public.pitch_log ADD COLUMN IF NOT EXISTS platform_pitch_url text;
ALTER TABLE public.pitch_log ADD COLUMN IF NOT EXISTS platform_cost_usd numeric DEFAULT 0;
