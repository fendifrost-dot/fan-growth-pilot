import React from "react";
import { Play, Users, RefreshCw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useArtistStats } from "@/hooks/useArtistStats";
import {
  PageHeader,
  StatTile,
  HubLoading,
  HubEmpty,
  LastUpdated,
  compactNumber,
} from "@/components/hub/HubPrimitives";
import { toast } from "sonner";

const HubSpotify: React.FC = () => {
  const { stats, isLoading, error, refresh, isRefreshing } = useArtistStats();

  const handleRefresh = () => {
    refresh(undefined, {
      onSuccess: () => toast.success("Spotify metrics refreshed"),
      onError: (e: unknown) =>
        toast.error(
          e instanceof Error
            ? `Refresh failed: ${e.message}`
            : "Could not refresh Spotify metrics — try again shortly.",
        ),
    });
  };

  const monthly = stats?.spotify.monthly_listeners ?? 0;
  const followers = stats?.spotify.followers ?? 0;
  const hasData = monthly > 0 || followers > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spotify"
        description="Monthly listeners and follower growth, sourced from Chartmetric."
        actions={
          <Button onClick={handleRefresh} disabled={isRefreshing} className="gap-2">
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {isLoading ? (
        <HubLoading label="Loading Spotify metrics…" />
      ) : error ? (
        <HubEmpty
          title="Couldn't load Spotify metrics"
          description="Try refreshing. If it keeps failing, the Chartmetric source may be temporarily unavailable."
          action={
            <Button variant="outline" onClick={handleRefresh}>
              Try again
            </Button>
          }
        />
      ) : !hasData ? (
        <HubEmpty
          icon={Play}
          title="No Spotify metrics yet"
          description="Hit Refresh to pull the latest monthly listeners and followers from Chartmetric."
          action={
            <Button onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh now
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex justify-end">
            <LastUpdated iso={stats?.sources.spotify} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatTile
              label="Monthly listeners"
              value={compactNumber(monthly)}
              sub={`${monthly.toLocaleString()} this period`}
              icon={Play}
            />
            <StatTile
              label="Followers"
              value={compactNumber(followers)}
              sub={`${followers.toLocaleString()} total`}
              icon={Users}
            />
          </div>
        </>
      )}

      <Card className="p-5 bg-muted/30 border-border">
        <div className="flex gap-3">
          <Info className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How this updates</p>
            <p>
              Spotify numbers are pulled from Chartmetric on demand when you hit{" "}
              <strong>Refresh</strong>, and can also be refreshed automatically on a schedule.
              The card above shows when the data was last written.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default HubSpotify;
