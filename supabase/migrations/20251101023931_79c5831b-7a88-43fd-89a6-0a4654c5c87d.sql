-- Create profiles table for user data
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  artist_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Create platform_connections table for OAuth tokens and platform data
CREATE TABLE public.platform_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, -- 'spotify', 'instagram', 'facebook', 'soundcloud', 'apple_music', 'youtube'
  platform_user_id TEXT, -- Platform-specific user ID
  username TEXT,
  profile_url TEXT,
  access_token TEXT, -- Encrypted OAuth token
  refresh_token TEXT, -- For refreshing access
  token_expires_at TIMESTAMP WITH TIME ZONE,
  is_connected BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB, -- Platform-specific data (followers, etc.)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

ALTER TABLE public.platform_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own connections"
  ON public.platform_connections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own connections"
  ON public.platform_connections FOR ALL
  USING (auth.uid() = user_id);

-- Create fan_data table for aggregated fan/listener information
CREATE TABLE public.fan_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  fan_identifier TEXT, -- Email, phone, or platform ID
  fan_name TEXT,
  fan_email TEXT,
  fan_phone TEXT,
  engagement_score INTEGER DEFAULT 0, -- 0-100 score based on interactions
  total_streams INTEGER DEFAULT 0,
  total_interactions INTEGER DEFAULT 0,
  last_interaction_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB, -- Platform-specific fan data
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.fan_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own fan data"
  ON public.fan_data FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own fan data"
  ON public.fan_data FOR ALL
  USING (auth.uid() = user_id);

-- Create smart_links table for custom tracking URLs
CREATE TABLE public.smart_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, -- URL slug (fan-growth-pilot.lovable.app/l/SLUG)
  destination_url TEXT NOT NULL,
  thumbnail_url TEXT,
  is_active BOOLEAN DEFAULT true,
  click_count INTEGER DEFAULT 0,
  conversion_count INTEGER DEFAULT 0,
  metadata JSONB, -- UTM params, A/B test variants, etc.
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.smart_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own smart links"
  ON public.smart_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own smart links"
  ON public.smart_links FOR ALL
  USING (auth.uid() = user_id);

-- Public policy for link clicks (anyone can read to redirect)
CREATE POLICY "Anyone can read active smart links"
  ON public.smart_links FOR SELECT
  USING (is_active = true);

-- Create link_analytics table for tracking clicks and conversions
CREATE TABLE public.link_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES public.smart_links(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  country TEXT,
  city TEXT,
  device_type TEXT, -- 'mobile', 'desktop', 'tablet'
  converted BOOLEAN DEFAULT false,
  conversion_value DECIMAL,
  metadata JSONB
);

ALTER TABLE public.link_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own link analytics"
  ON public.link_analytics FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert link analytics"
  ON public.link_analytics FOR INSERT
  WITH CHECK (true); -- Allow anyone to track clicks

-- Create function for updating timestamps
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Add triggers for updated_at
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.platform_connections
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.fan_data
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.smart_links
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Create function to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger to create profile on user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();