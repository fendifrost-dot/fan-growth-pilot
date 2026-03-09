
-- ============================================================
-- PHASE 1: Fan Intelligence Data Model
-- All tables are additive — no existing tables are modified
-- ============================================================

-- 1. fan_profiles: One profile per identifiable fan/lead
CREATE TABLE public.fan_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  email text,
  phone text,
  city text,
  region text,
  country text,
  first_source text,
  first_song text,
  first_touch_at timestamptz DEFAULT now(),
  last_touch_at timestamptz DEFAULT now(),
  total_page_views integer NOT NULL DEFAULT 0,
  total_cta_clicks integer NOT NULL DEFAULT 0,
  total_email_signups integer NOT NULL DEFAULT 0,
  total_purchases integer NOT NULL DEFAULT 0,
  total_purchase_value numeric NOT NULL DEFAULT 0,
  fan_score integer NOT NULL DEFAULT 0,
  fan_tier text NOT NULL DEFAULT 'casual',
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, email)
);

-- 2. fan_events: Append-only event log
CREATE TABLE public.fan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_profile_id uuid REFERENCES public.fan_profiles(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_source text,
  song_slug text,
  campaign_id text,
  city text,
  country text,
  device_type text,
  value numeric,
  metadata jsonb DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- 3. momentum_events: Detected growth events
CREATE TABLE public.momentum_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  metric_name text NOT NULL,
  metric_source text NOT NULL DEFAULT 'chartmetric',
  previous_value numeric,
  current_value numeric,
  absolute_change numeric,
  percent_change numeric,
  related_song text,
  related_city text,
  severity text NOT NULL DEFAULT 'info',
  status text NOT NULL DEFAULT 'new',
  detected_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb
);

-- 4. marketing_actions: Recommended or triggered actions
CREATE TABLE public.marketing_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'medium',
  related_fan_profile_id uuid REFERENCES public.fan_profiles(id) ON DELETE SET NULL,
  related_momentum_event_id uuid REFERENCES public.momentum_events(id) ON DELETE SET NULL,
  related_city text,
  related_song text,
  recommendation_text text NOT NULL,
  action_payload jsonb DEFAULT '{}'::jsonb,
  executed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 5. analytics_snapshots: Point-in-time metric snapshots for trend analysis
CREATE TABLE public.analytics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  monthly_listeners integer DEFAULT 0,
  spotify_followers integer DEFAULT 0,
  playlist_count integer DEFAULT 0,
  playlist_reach integer DEFAULT 0,
  ig_followers integer DEFAULT 0,
  x_followers integer DEFAULT 0,
  fb_followers integer DEFAULT 0,
  shazams integer DEFAULT 0,
  chartmetric_rank integer DEFAULT 0,
  youtube_subscribers integer DEFAULT 0,
  youtube_views integer DEFAULT 0,
  soundcloud_followers integer DEFAULT 0,
  soundcloud_plays integer DEFAULT 0,
  tiktok_views integer DEFAULT 0,
  pandora_listeners integer DEFAULT 0,
  top_market text,
  secondary_market text,
  metadata jsonb DEFAULT '{}'::jsonb,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

-- 6. system_logs: Observability for Phase 8
CREATE TABLE public.system_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  process_name text NOT NULL,
  status text NOT NULL DEFAULT 'success',
  message text,
  duration_ms integer,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- ============================================================
-- RLS POLICIES
-- ============================================================

ALTER TABLE public.fan_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.momentum_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

-- fan_profiles
CREATE POLICY "Users can manage own fan profiles" ON public.fan_profiles FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Deny anonymous fan_profiles" ON public.fan_profiles FOR ALL TO anon USING (false);

-- fan_events
CREATE POLICY "Users can view own fan events" ON public.fan_events FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own fan events" ON public.fan_events FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Deny anonymous fan_events" ON public.fan_events FOR ALL TO anon USING (false);

-- momentum_events
CREATE POLICY "Users can manage own momentum events" ON public.momentum_events FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Deny anonymous momentum_events" ON public.momentum_events FOR ALL TO anon USING (false);

-- marketing_actions
CREATE POLICY "Users can manage own marketing actions" ON public.marketing_actions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Deny anonymous marketing_actions" ON public.marketing_actions FOR ALL TO anon USING (false);

-- analytics_snapshots
CREATE POLICY "Users can view own snapshots" ON public.analytics_snapshots FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own snapshots" ON public.analytics_snapshots FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Deny anonymous analytics_snapshots" ON public.analytics_snapshots FOR ALL TO anon USING (false);

-- system_logs
CREATE POLICY "Users can view own system logs" ON public.system_logs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Deny anonymous system_logs" ON public.system_logs FOR ALL TO anon USING (false);

-- ============================================================
-- INDEXES for performance
-- ============================================================

CREATE INDEX idx_fan_profiles_user_email ON public.fan_profiles(user_id, email);
CREATE INDEX idx_fan_profiles_fan_tier ON public.fan_profiles(user_id, fan_tier);
CREATE INDEX idx_fan_profiles_fan_score ON public.fan_profiles(user_id, fan_score DESC);
CREATE INDEX idx_fan_events_profile ON public.fan_events(fan_profile_id, occurred_at DESC);
CREATE INDEX idx_fan_events_user_type ON public.fan_events(user_id, event_type, occurred_at DESC);
CREATE INDEX idx_momentum_events_user ON public.momentum_events(user_id, detected_at DESC);
CREATE INDEX idx_momentum_events_status ON public.momentum_events(user_id, status);
CREATE INDEX idx_marketing_actions_user ON public.marketing_actions(user_id, status, created_at DESC);
CREATE INDEX idx_analytics_snapshots_user ON public.analytics_snapshots(user_id, snapshot_at DESC);
CREATE INDEX idx_system_logs_process ON public.system_logs(process_name, created_at DESC);

-- ============================================================
-- TRIGGER: auto-update updated_at
-- ============================================================

CREATE TRIGGER set_fan_profiles_updated_at BEFORE UPDATE ON public.fan_profiles FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER set_marketing_actions_updated_at BEFORE UPDATE ON public.marketing_actions FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
