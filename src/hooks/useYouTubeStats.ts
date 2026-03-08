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

export interface YouTubeAnalytics {
  overview: {
    views_30d: number;
    watch_time_minutes_30d: number;
    avg_view_duration_seconds: number;
    subscribers_gained_30d: number;
    subscribers_lost_30d: number;
    likes_30d: number;
    dislikes_30d: number;
    shares_30d: number;
    comments_30d: number;
  } | null;
  demographics: Array<{
    age_group: string;
    gender: string;
    viewer_percentage: number;
  }>;
  traffic_sources: Array<{
    source: string;
    views: number;
    watch_time_minutes: number;
  }>;
  daily_stats: Array<{
    date: string;
    views: number;
    watch_time_minutes: number;
    subscribers_gained: number;
  }>;
}

export interface YouTubeStats {
  channel_id: string;
  channel_name: string;
  channel_thumbnail: string;
  subscribers: number;
  total_views: number;
  video_count: number;
  top_videos: YouTubeVideo[];
  analytics: YouTubeAnalytics | null;
  has_oauth: boolean;
  updated_at: string;
}

export const useYouTubeStats = () => {
  const queryClient = useQueryClient();

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
        analytics: meta.analytics ?? null,
        has_oauth: meta.has_oauth ?? false,
        updated_at: data.updated_at ?? "",
      };
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

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
