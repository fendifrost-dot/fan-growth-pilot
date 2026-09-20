import React from "react";
import { Link } from "react-router-dom";
import { Play, Users, Instagram, Youtube, Music2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { MetricCardSkeleton } from "@/components/skeletons/MetricCardSkeleton";
import { MomentumAlerts } from "@/components/MomentumAlerts";
import { MarketingRecommendations } from "@/components/MarketingRecommendations";
import { useArtistStats } from "@/hooks/useArtistStats";
import { PageHeader, LastUpdated, compactNumber } from "@/components/hub/HubPrimitives";
import { HUB_NAV } from "@/components/hub/hubNav";
import { toast } from "sonner";

const HubDashboard: React.FC = () => {
  const {
    stats,
    isLoading,
    refresh,
    isRefreshing,
  } = useArtistStats();

  const handleRefresh = () => {
    refresh(undefined, {
      onSuccess: () => toast.success("Stats refreshed"),
      onError: (e: unknown) =>
        toast.error(
          e instanceof Error ? e.message : "Could not refresh stats — try again shortly.",
        ),
    });
  };

  return (
    <div className="space-y-10">
      <PageHeader
        title="Welcome back, Fendi"
        description="Your growth command center — track every channel, links, and outreach lane from one place."
        actions={
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing…" : "↻ Refresh stats"}
          </Button>
        }
      />

      {/* Key metrics */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Performance overview</h3>
          {stats && <LastUpdated iso={stats.updated_at} />}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            <>
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
              <MetricCardSkeleton />
            </>
          ) : (
            <>
              <MetricCard
                title="Monthly Listeners"
                value={stats ? compactNumber(stats.spotify.monthly_listeners) : "No data"}
                change="Spotify"
                icon={Play}
                trend="up"
              />
              <MetricCard
                title="Spotify Followers"
                value={stats ? compactNumber(stats.spotify.followers) : "No data"}
                change="Spotify"
                icon={Users}
                trend="up"
              />
              <MetricCard
                title="IG Followers"
                value={stats ? compactNumber(stats.instagram.followers) : "No data"}
                change="Instagram"
                icon={Instagram}
                trend="up"
              />
              <MetricCard
                title="YT Subscribers"
                value={stats ? compactNumber(stats.youtube.subscribers) : "No data"}
                change="YouTube"
                icon={Youtube}
                trend="up"
              />
            </>
          )}
        </div>
      </section>

      {/* Section shortcuts */}
      <section>
        <h3 className="text-lg font-semibold mb-4">Jump to a section</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {HUB_NAV.flatMap((g) => g.items)
            .filter((i) => i.to !== "/hub")
            .map((item) => {
              const Icon = item.icon;
              return (
                <Card
                  key={item.to}
                  className="p-5 bg-card/50 border-border hover:shadow-glow transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium">{item.label}</p>
                      <p className="text-sm text-muted-foreground">{item.description}</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="mt-3 -ml-2" asChild>
                    <Link to={item.to}>
                      Open <ArrowRight className="w-4 h-4 ml-1" />
                    </Link>
                  </Button>
                </Card>
              );
            })}
        </div>
      </section>

      {/* Momentum + recommendations */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MomentumAlerts />
        <MarketingRecommendations />
      </section>
    </div>
  );
};

export default HubDashboard;
