import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Interface for a SoundCloud track as stored in fan_data.metadata.top_tracks
 */
export interface SoundCloudTrack {
  id: number;
  title: string;
  artwork_url: string | null;
  playback_count: number;
  likes_count: number;
  comment_count: number;
  reposts_count: number;
  permalink_url: string;
  created_at: string;
}

/**
 * Interface for SoundCloud stats
 */
export interface SoundCloudStats {
  followers: number;
  total_plays: number;
  total_plays_all_tracks: number;
  total_plays_public_catalog: number;
  total_likes: number;
  total_comments: number;
  total_reposts: number;
  top_tracks: SoundCloudTrack[];
}

/**
 * Interface for all artist stats across platforms
 */
export interface ArtistStats {
  spotify: {
    followers: number;
    monthly_listeners: number;
  };
  instagram: {
    followers: number;
  };
  facebook: {
    followers: number;
  };
  youtube: {
    subscribers: number;
    total_views: number;
  };
  soundcloud: SoundCloudStats;
  updated_at: string | null;
}

/**
 * Default SoundCloud stats when no data is available
 */
const defaultSoundCloudStats: SoundCloudStats = {
  followers: 0,
  total_plays: 0,
  total_plays_all_tracks: 0,
  total_plays_public_catalog: 0,
  total_likes: 0,
  total_comments: 0,
  total_reposts: 0,
  top_tracks: [],
};

export const useArtistStats = () => {
  const queryClient = useQueryClient();

  // Read stats from fan_data table
  const query = useQuery({
    queryKey: ["artist-stats"],
    queryFn: async (): Promise<ArtistStats> => {
      const { data, error } = await supabase
        .from("fan_data")
        .select("*")
        .in("fan_identifier", ["spotify_artist_stats", "instagram_stats", "facebook_stats", "youtube_channel_stats", "soundcloud_user_stats"]);

      if (error) throw error;

      const spotify = data?.find((d) => d.fan_identifier === "spotify_artist_stats");
      const instagram = data?.find((d) => d.fan_identifier === "instagram_stats");
      const facebook = data?.find((d) => d.fan_identifier === "facebook_stats");
      const youtube = data?.find((d) => d.fan_identifier === "youtube_channel_stats");
      const soundcloud = data?.find((d) => d.fan_identifier === "soundcloud_user_stats");

      // Safe metadata accessor
      const meta = (row: typeof data[number] | undefined): Record<string, unknown> => {
        if (!row) return {};
        if (row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
          return row.metadata as Record<string, unknown>;
        }
        return {};
      };

      // Parse SoundCloud stats with safe fallbacks
      const scMeta = meta(soundcloud);
      const soundcloudStats: SoundCloudStats = {
        followers: typeof scMeta.followers === "number" ? scMeta.followers : (soundcloud?.total_interactions ?? 0),
        total_plays: typeof scMeta.total_plays === "number" ? scMeta.total_plays : (soundcloud?.total_streams ?? 0),
        total_likes: typeof scMeta.total_likes === "number" ? scMeta.total_likes : 0,
        total_comments: typeof scMeta.total_comments === "number" ? scMeta.total_comments : 0,
        total_reposts: typeof scMeta.total_reposts === "number" ? scMeta.total_reposts : 0,
        top_tracks: Array.isArray(scMeta.top_tracks) ? scMeta.top_tracks as SoundCloudTrack[] : [],
      };

      return {
        spotify: {
          followers: typeof meta(spotify).followers === "number" ? meta(spotify).followers as number : (spotify?.total_interactions ?? 0),
          monthly_listeners: typeof meta(spotify).monthly_listeners === "number" ? meta(spotify).monthly_listeners as number : (spotify?.total_streams ?? 0),
        },
        instagram: {
          followers: typeof meta(instagram).followers === "number" ? meta(instagram).followers as number : (instagram?.total_interactions ?? 0),
        },
        facebook: {
          followers: typeof meta(facebook).followers === "number" ? meta(facebook).followers as number : (facebook?.total_interactions ?? 0),
        },
        youtube: {
          subscribers: typeof meta(youtube).subscribers === "number" ? meta(youtube).subscribers as number : (youtube?.total_interactions ?? 0),
          total_views: typeof meta(youtube).total_views === "number" ? meta(youtube).total_views as number : (youtube?.total_streams ?? 0),
        },
        soundcloud: soundcloudStats,
        updated_at: spotify?.updated_at ?? null,
      };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
  });

  // Trigger a refresh by calling both Spotify and YouTube edge functions in parallel
  const refreshMutation = useMutation({
    mutationFn: async () => {
      const [spotifyResult] = await Promise.allSettled([
        supabase.functions.invoke("fetch-public-spotify-data"),
        supabase.functions.invoke("youtube-stats", { body: {} }),
        supabase.functions.invoke("soundcloud-stats", { body: {} }),
      ]);
      if (spotifyResult.status === "rejected") throw spotifyResult.reason;
      const { error } = spotifyResult.value;
      if (error) throw error;
      return spotifyResult.value.data as ArtistStats;
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
