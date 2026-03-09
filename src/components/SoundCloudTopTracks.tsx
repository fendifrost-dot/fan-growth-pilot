import { Card } from "@/components/ui/card";
import { SoundCloudTrack } from "@/hooks/useArtistStats";
import { Play, Heart, MessageCircle, Repeat2, ExternalLink } from "lucide-react";

interface TopTracksTableProps {
  tracks: SoundCloudTrack[];
  totalPlays: number;
  totalLikes: number;
  totalComments: number;
  totalReposts: number;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export const SoundCloudTopTracks = ({ tracks, totalPlays, totalLikes, totalComments, totalReposts }: TopTracksTableProps) => {
  if (!tracks.length) return null;

  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-2xl font-semibold">SoundCloud Top Tracks</h3>
          <p className="text-sm text-muted-foreground mt-1">
            All-time: {formatNumber(totalPlays)} plays · {formatNumber(totalLikes)} likes · {formatNumber(totalComments)} comments · {formatNumber(totalReposts)} reposts
          </p>
        </div>
      </div>
      <div className="grid gap-3">
        {tracks.map((track, index) => (
          <Card
            key={track.id}
            className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300"
          >
            <div className="flex items-center gap-4">
              <span className="text-lg font-bold text-muted-foreground w-6 text-right shrink-0">
                {index + 1}
              </span>
              {track.artwork_url && (
                <img
                  src={track.artwork_url.replace("-large", "-t67x67")}
                  alt={track.title}
                  className="w-12 h-12 rounded object-cover shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <a
                  href={track.permalink_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium truncate block hover:text-primary transition-colors"
                >
                  {track.title}
                  <ExternalLink className="w-3 h-3 inline ml-1 opacity-50" />
                </a>
              </div>
              <div className="flex items-center gap-5 text-sm text-muted-foreground shrink-0">
                <span className="flex items-center gap-1" title="Plays">
                  <Play className="w-3.5 h-3.5" />
                  {formatNumber(track.playback_count)}
                </span>
                <span className="flex items-center gap-1" title="Likes">
                  <Heart className="w-3.5 h-3.5" />
                  {formatNumber(track.likes_count)}
                </span>
                <span className="flex items-center gap-1 hidden sm:flex" title="Comments">
                  <MessageCircle className="w-3.5 h-3.5" />
                  {formatNumber(track.comment_count)}
                </span>
                <span className="flex items-center gap-1 hidden sm:flex" title="Reposts">
                  <Repeat2 className="w-3.5 h-3.5" />
                  {formatNumber(track.reposts_count)}
                </span>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
};
