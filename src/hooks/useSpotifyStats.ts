import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SpotifyStats {
  followers: number;
  totalPlays: number;
  engagementRate: number;
  topTracks: Array<{
    name: string;
    artist: string;
    plays: number;
  }>;
  recentActivity: number;
}

export const useSpotifyStats = () => {
  return useQuery({
    queryKey: ["spotify-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<SpotifyStats>("spotify-stats");
      
      if (error) throw error;
      return data;
    },
    retry: 1, // Only retry once on failure
    refetchInterval: 30 * 1000, // Refetch every 30 seconds
    staleTime: 0, // Always consider data stale
    refetchOnWindowFocus: true, // Refetch when window regains focus
    refetchOnMount: true, // Refetch on component mount
  });
};
