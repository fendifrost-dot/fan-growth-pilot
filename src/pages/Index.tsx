import React, { useState, useEffect, lazy, Suspense } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MetricCard } from "@/components/MetricCard";
import { MetricCardSkeleton } from "@/components/skeletons/MetricCardSkeleton";
import { SmartLinkCardSkeleton } from "@/components/skeletons/SmartLinkCardSkeleton";
import { SmartLinkCard } from "@/components/SmartLinkCard";
import { AddSmartLinkDialog, SmartLink } from "@/components/AddSmartLinkDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSmartLinks } from "@/hooks/useSmartLinks";
import { useArtistStats } from "@/hooks/useArtistStats";
import { useShopifyConnection } from "@/hooks/useShopifyConnection";
import { toast } from "sonner";
import { 
  Play, 
  Users, 
  TrendingUp, 
  ShoppingBag,
  Instagram,
  Plus,
  Link as LinkIcon,
  Youtube,
} from "lucide-react";

// Lazy load the Email Leads section (below the fold)
const EmailLeadsSection = lazy(() => import("@/components/EmailLeadsSection").then(m => ({ default: m.EmailLeadsSection })));

const Index = () => {
  const [smartLinkDialogOpen, setSmartLinkDialogOpen] = useState(false);
  const [editingLink, setEditingLink] = useState<SmartLink | null>(null);
  
  const { smartLinks, isLoading: linksLoading, createSmartLink, updateSmartLink, removeSmartLink } = useSmartLinks();
  const { stats: artistStats, isLoading: statsLoading, refresh: refreshStats, isRefreshing } = useArtistStats();
  const { isConnected: shopifyConnected, isLoading: shopifyLoading } = useShopifyConnection();

  // Handle Spotify OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('spotify_connected') === 'true') {
      toast.success("Spotify connected successfully!");
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
      toast.error(params.get('error') || "Connection failed");
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  return (
    <div className="min-h-screen bg-gradient-dark">
      <DashboardHeader />
      
      <main className="container mx-auto px-6 py-8">
        {/* Hero Section */}
        <div className="mb-12">
          <h2 className="text-4xl font-bold mb-3">
            Welcome back, <span className="bg-gradient-gold bg-clip-text text-transparent">Artist</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Your fan data command center — track, analyze, and convert
          </p>
        </div>

        {/* Key Metrics */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-2xl font-semibold">Performance Overview</h3>
            <Button variant="outline" size="sm" onClick={() => refreshStats()} disabled={isRefreshing}>
              {isRefreshing ? "Refreshing…" : "↻ Refresh Stats"}
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {statsLoading || shopifyLoading ? (
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
                  value={artistStats ? `${(artistStats.spotify.monthly_listeners / 1000).toFixed(1)}K` : "No data"}
                  change="Spotify"
                  icon={Play}
                  trend="up"
                />
                <MetricCard
                  title="Spotify Followers"
                  value={artistStats ? `${(artistStats.spotify.followers / 1000).toFixed(1)}K` : "No data"}
                  change="Spotify"
                  icon={Users}
                  trend="up"
                />
                <MetricCard
                  title="IG Followers"
                  value={artistStats ? `${(artistStats.instagram.followers / 1000).toFixed(1)}K` : "No data"}
                  change="Instagram"
                  icon={Instagram}
                  trend="up"
                />
                <MetricCard
                  title="Merch Sales"
                  value={shopifyConnected ? "Connected" : "Connect Shopify"}
                  change={shopifyConnected ? "Store connected" : "No data"}
                  icon={ShoppingBag}
                  trend="up"
                />
              </>
            )}
          </div>
        </section>

        {/* Smart Links — full width now that Connected Accounts is removed */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-2xl font-semibold">Smart Links</h3>
            <Button variant="outline" className="gap-2" onClick={() => setSmartLinkDialogOpen(true)}>
              <Plus className="w-4 h-4" />
              Create Smart Link
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {linksLoading ? (
              <>
                <SmartLinkCardSkeleton />
                <SmartLinkCardSkeleton />
              </>
            ) : smartLinks.length > 0 ? (
              smartLinks.map((link) => (
                <SmartLinkCard
                  key={link.id}
                  title={link.title}
                  url={link.destination_url}
                  slug={link.slug}
                  shortCode={link.short_code}
                  ogImageUrl={link.og_image_url}
                  clicks={link.click_count || 0}
                  ctaClicks={link.cta_click_count || 0}
                  conversions={link.conversion_count || 0}
                  onRemove={() => removeSmartLink(link.id)}
                  onEdit={() => {
                    setEditingLink(link);
                    setSmartLinkDialogOpen(true);
                  }}
                />
              ))
            ) : (
              <Card className="p-8 text-center bg-card/50 backdrop-blur-sm border-border border-dashed col-span-full">
                <p className="text-muted-foreground mb-4">No smart links created yet</p>
                <Button onClick={() => setSmartLinkDialogOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Your First Smart Link
                </Button>
              </Card>
            )}
          </div>
        </section>

        {/* Email Leads & Retargeting - Lazy Loaded */}
        <Suspense fallback={
          <section className="space-y-6">
            <h3 className="text-2xl font-semibold">Email Leads & Retargeting</h3>
            <div className="grid gap-6">
              <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
                <div className="space-y-4">
                  <div className="h-6 w-48 bg-muted-foreground/20 rounded"></div>
                  <div className="h-4 w-full bg-muted-foreground/20 rounded"></div>
                  <div className="h-10 w-32 bg-muted-foreground/20 rounded"></div>
                </div>
              </Card>
            </div>
          </section>
        }>
          <EmailLeadsSection />
        </Suspense>

        {/* Quick Actions */}
        <section className="mt-12 mb-8">
          <Card className="p-8 bg-gradient-gold text-primary-foreground">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-bold mb-2">Ready to grow your fanbase?</h3>
                <p className="text-primary-foreground/80">
                  Create a new smart link to expand your reach
                </p>
              </div>
              <Button size="lg" variant="secondary" onClick={() => setSmartLinkDialogOpen(true)}>
                <LinkIcon className="w-5 h-5 mr-2" />
                Create Smart Link
              </Button>
            </div>
          </Card>
        </section>
      </main>

      <AddSmartLinkDialog
        open={smartLinkDialogOpen}
        onOpenChange={(open) => {
          setSmartLinkDialogOpen(open);
          if (!open) setEditingLink(null);
        }}
        onAdd={createSmartLink}
        editLink={editingLink}
        onUpdate={(updatedLink) => {
          updateSmartLink(updatedLink);
          setEditingLink(null);
        }}
      />
    </div>
  );
};

export default Index;
