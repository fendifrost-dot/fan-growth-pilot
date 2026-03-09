import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface FanProfile {
  id: string;
  email: string | null;
  city: string | null;
  country: string | null;
  fan_score: number;
  fan_tier: string;
  total_page_views: number;
  total_cta_clicks: number;
  total_email_signups: number;
  total_purchases: number;
  total_purchase_value: number;
  first_source: string | null;
  first_song: string | null;
  last_touch_at: string | null;
  created_at: string | null;
}

export interface FanTierCounts {
  casual: number;
  engaged: number;
  superfan: number;
  total: number;
}

export const useFanProfiles = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["fan-profiles"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("fan_profiles")
        .select("*")
        .eq("user_id", user.id)
        .order("fan_score", { ascending: false })
        .limit(500);

      if (error) throw error;
      return data as FanProfile[];
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const fans = data || [];

  const tierCounts: FanTierCounts = {
    casual: fans.filter(f => f.fan_tier === 'casual').length,
    engaged: fans.filter(f => f.fan_tier === 'engaged').length,
    superfan: fans.filter(f => f.fan_tier === 'superfan').length,
    total: fans.length,
  };

  return { fans, tierCounts, isLoading };
};
