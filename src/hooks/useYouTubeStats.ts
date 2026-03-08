import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface YouTubeVideo {
  id: string;
  title: string;
  thumbnail: string;
  published_at: string;
  views: number;
  likes: number;
  comments: number;
}

export interface YouTubeStats {
  channel_id: string;
  channel_name: string;
  channel_thumbnail: string;
  subscribers: number;
  total_views: number;
  video_count: number;
  top_videos: YouTubeVideo[];
  updated_at: string;
}

export const useYouTubeStats = () => {
  const queryClient = useQueryClient();

  // Read cached stats from fan_data
  const query = useQuery({
    queryKey: ["youtube-stats"],
    queryFn: async (): Promise<YouTubeStats | null> => {
      const { data, error } = await supabase
        .from("fan_data")
        .select("*")
        .eq("fan_identifier", "youtube_channel_stats")
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      const meta = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<string, any>;

      return {
        channel_id: meta.channel_id ?? "",
        channel_name: data.fan_name ?? "",
        channel_thumbnail: meta.channel_thumbnail ?? "",
        subscribers: meta.subscribers ?? data.total_interactions ?? 0,
        total_views: meta.total_views ?? data.total_streams ?? 0,
        video_count: meta.video_count ?? 0,
        top_videos: meta.top_videos ?? [],
        updated_at: data.updated_at ?? "",
      };
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  // Trigger fresh fetch from YouTube API
  const refreshMutation = useMutation({
    mutationFn: async (channelHandle?: string) => {
      const { data, error } = await supabase.functions.invoke("youtube-stats", {
        body: channelHandle ? { channel_handle: channelHandle } : {},
      });
      if (error) throw error;
      return data as YouTubeStats;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["youtube-stats"] });
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
