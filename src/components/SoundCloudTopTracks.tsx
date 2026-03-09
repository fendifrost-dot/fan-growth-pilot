import React from "react";
import { Card } from "@/components/ui/card";
import { Play, Heart, MessageCircle, Repeat2, ExternalLink } from "lucide-react";

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
 * Props for the SoundCloudTopTracks component
 */
interface SoundCloudTopTracksProps {
  tracks: SoundCloudTrack[] | undefined | null;
  totalPlays: number;
  totalLikes: number;
  totalComments: number;
  totalReposts: number;
}

/**
 * Format a number for display (e.g., 1000 -> 1K, 1000000 -> 1M)
 */
function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Get a higher resolution artwork URL if available
 */
function getArtworkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Replace -large with -t200x200 for better quality
  return url.replace("-large", "-t200x200");
}

/**
 * SoundCloudTopTracks component
 * 
 * Displays a summary bar with all-time totals and a list of top 10 tracks
 * with their individual engagement metrics.
 */
export const SoundCloudTopTracks: React.FC<SoundCloudTopTracksProps> = ({
  tracks,
  totalPlays,
  totalLikes,
  totalComments,
  totalReposts,
}) => {
  // Guard against undefined/null tracks
  const safeTracks = Array.isArray(tracks) ? tracks : [];

  // Don't render if no tracks
  if (safeTracks.length === 0) {
    return null;
  }

  return (
    <section className="mb-12">
      {/* Header with summary bar */}
      <div className="flex flex-col gap-2 mb-6">
        <h3 className="text-2xl font-semibold">SoundCloud Top Tracks</h3>
        <p className="text-sm text-muted-foreground">
          All-time: {formatNumber(totalPlays)} plays · {formatNumber(totalLikes)} likes · {formatNumber(totalComments)} comments · {formatNumber(totalReposts)} reposts
        </p>
      </div>

      {/* Track list */}
      <div className="grid gap-3">
        {safeTracks.map((track, index) => {
          // Guard against malformed track objects
          if (!track || typeof track !== "object") {
            return null;
          }

          const trackId = track.id ?? index;
          const trackTitle = track.title ?? "Unknown Track";
          const artworkUrl = getArtworkUrl(track.artwork_url);
          const playbackCount = track.playback_count ?? 0;
          const likesCount = track.likes_count ?? 0;
          const commentCount = track.comment_count ?? 0;
          const repostsCount = track.reposts_count ?? 0;
          const permalinkUrl = track.permalink_url ?? "#";

          return (
            <Card
              key={trackId}
              className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300"
            >
              <div className="flex items-center gap-4">
                {/* Rank number */}
                <span className="text-lg font-bold text-muted-foreground w-6 text-right shrink-0">
                  {index + 1}
                </span>

                {/* Artwork */}
                {artworkUrl ? (
                  <img
                    src={artworkUrl}
                    alt={trackTitle}
                    className="w-12 h-12 rounded object-cover shrink-0"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-12 h-12 rounded bg-muted shrink-0 flex items-center justify-center">
                    <Play className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}

                {/* Track title with link */}
                <div className="flex-1 min-w-0">
                  <a
                    href={permalinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium truncate block hover:text-primary transition-colors"
                    title={trackTitle}
                  >
                    {trackTitle}
                    <ExternalLink className="w-3 h-3 inline ml-1 opacity-50" />
                  </a>
                </div>

                {/* Engagement metrics */}
                <div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
                  <span className="flex items-center gap-1" title="Plays">
                    <Play className="w-3.5 h-3.5" />
                    <span className="hidden xs:inline">{formatNumber(playbackCount)}</span>
                    <span className="xs:hidden">{formatNumber(playbackCount)}</span>
                  </span>
                  <span className="flex items-center gap-1" title="Likes">
                    <Heart className="w-3.5 h-3.5" />
                    <span>{formatNumber(likesCount)}</span>
                  </span>
                  <span className="hidden sm:flex items-center gap-1" title="Comments">
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>{formatNumber(commentCount)}</span>
                  </span>
                  <span className="hidden sm:flex items-center gap-1" title="Reposts">
                    <Repeat2 className="w-3.5 h-3.5" />
                    <span>{formatNumber(repostsCount)}</span>
                  </span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
};

export default SoundCloudTopTracks;
