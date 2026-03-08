import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ArtistStats {
  spotify: { followers: number; monthly_listeners: number };
  instagram: { followers: number };
  facebook: { followers: number };
  youtube: { subscribers: number; total_views: number };
  updated_at: string | null;
}

export const useArtistStats = () => {
  const queryClient = useQueryClient();

  // Read stats from fan_data table
  const query = useQuery({
    queryKey: ["artist-stats"],
    queryFn: async (): Promise<ArtistStats> => {
      const { data, error } = await supabase
        .from("fan_data")
        .select("*")
        .in("fan_identifier", ["spotify_artist_stats", "instagram_stats", "facebook_stats", "youtube_channel_stats"]);

      if (error) throw error;

      const spotify = data?.find((d) => d.fan_identifier === "spotify_artist_stats");
      const instagram = data?.find((d) => d.fan_identifier === "instagram_stats");
      const facebook = data?.find((d) => d.fan_identifier === "facebook_stats");

      const meta = (row: any) => (row?.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, any>;

      return {
        spotify: {
          followers: meta(spotify).followers ?? spotify?.total_interactions ?? 0,
          monthly_listeners: meta(spotify).monthly_listeners ?? spotify?.total_streams ?? 0,
        },
        instagram: {
          followers: meta(instagram).followers ?? instagram?.total_interactions ?? 0,
        },
        facebook: {
          followers: meta(facebook).followers ?? facebook?.total_interactions ?? 0,
        },
        updated_at: spotify?.updated_at ?? null,
      };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
  });

  // Trigger a refresh by calling the edge function
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("fetch-public-spotify-data");
      if (error) throw error;
      return data as ArtistStats;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["artist-stats"] });
    },
  });

  return {
    stats: query.data,
    isLoading: query.isLoading,
    error: query.error,
    refresh: refreshMutation.mutate,
    isRefreshing: refreshMutation.isPending,
  };
};
