import React from "react";
import { Link } from "react-router-dom";
import { Youtube, Eye, Video, Share2, RefreshCw, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useYouTubeStats } from "@/hooks/useYouTubeStats";
import {
  PageHeader,
  StatTile,
  HubLoading,
  HubEmpty,
  LastUpdated,
  compactNumber,
} from "@/components/hub/HubPrimitives";
import { toast } from "sonner";

const HubYouTube: React.FC = () => {
  const { stats, isLoading, refresh, isRefreshing } = useYouTubeStats();

  const handleRefresh = () => {
    refresh(undefined, {
      onSuccess: () => toast.success("YouTube stats refreshed"),
      onError: (e: unknown) =>
        toast.error(
          e instanceof Error ? `Refresh failed: ${e.message}` : "Could not refresh YouTube.",
        ),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="YouTube"
        description="Channel growth plus the Native Share Growth Pilot — a separate lane from playlist pitching."
        actions={
          <Button onClick={handleRefresh} disabled={isRefreshing} className="gap-2">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {/* Native Share pilot — surfaced prominently so it's easy to find */}
      <Card className="p-6 border-primary/30 bg-primary/5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
              <Share2 className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">YouTube Native Share Growth Pilot</h3>
              <p className="text-sm text-muted-foreground max-w-xl">
                Seed native shares from creator channels — targets, moments, verification,
                and observed lift. Runs as its own lane, independent of playlist pitching.
              </p>
            </div>
          </div>
          <Button asChild className="shrink-0">
            <Link to="/hub/youtube/native-share">
              Open pilot <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </Button>
        </div>
      </Card>

      {/* Channel stats */}
      {isLoading ? (
        <HubLoading label="Loading YouTube channel stats…" />
      ) : !stats ? (
        <HubEmpty
          icon={Youtube}
          title="No YouTube stats yet"
          description="Connect the channel and hit Refresh to pull subscribers, views, and top videos."
          action={
            <Button onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh now
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">
              {stats.channel_name || "Channel"} overview
            </h3>
            <LastUpdated iso={stats.updated_at} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile
              label="Subscribers"
              value={compactNumber(stats.subscribers)}
              icon={Youtube}
            />
            <StatTile
              label="Total views"
              value={compactNumber(stats.total_views)}
              icon={Eye}
            />
            <StatTile label="Videos" value={stats.video_count} icon={Video} />
          </div>

          {stats.top_videos.length > 0 && (
            <Card className="p-5 bg-card/50 border-border">
              <h3 className="font-semibold mb-3">Top videos</h3>
              <div className="space-y-2">
                {stats.top_videos.slice(0, 5).map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 truncate">{v.title}</span>
                    <span className="text-muted-foreground shrink-0">
                      {compactNumber(v.views)} views
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
};

export default HubYouTube;
