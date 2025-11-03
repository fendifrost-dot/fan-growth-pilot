import React, { useState, useEffect } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MetricCard } from "@/components/MetricCard";
import { ConnectedAccountCard } from "@/components/ConnectedAccountCard";
import { SmartLinkCard } from "@/components/SmartLinkCard";
import { AddPlatformDialog, PlatformAccount } from "@/components/AddPlatformDialog";
import { AddSmartLinkDialog, SmartLink } from "@/components/AddSmartLinkDialog";
import { UploadEvenCSV } from "@/components/UploadEvenCSV";
import { LeadFilters } from "@/components/LeadFilters";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePlatformConnections } from "@/hooks/usePlatformConnections";
import { useSmartLinks } from "@/hooks/useSmartLinks";
import { useSpotifyStats } from "@/hooks/useSpotifyStats";
import { useShopifyConnection } from "@/hooks/useShopifyConnection";
import { useSmartLinkLeads } from "@/hooks/useSmartLinkLeads";
import { useLeadSegments, type LeadSegment } from "@/hooks/useLeadSegments";
import { toast } from "sonner";
import { 
  Play, 
  Users, 
  TrendingUp, 
  ShoppingBag,
  Music,
  Instagram,
  Youtube,
  Facebook,
  Plus,
  Link as LinkIcon,
  Music2,
  Apple
} from "lucide-react";

const platformIcons: Record<string, any> = {
  Spotify: Music,
  Instagram: Instagram,
  YouTube: Youtube,
  Facebook: Facebook,
  SoundCloud: Music2,
  "Apple Music": Apple,
};

const Index = () => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [smartLinkDialogOpen, setSmartLinkDialogOpen] = useState(false);
  const [activeSegment, setActiveSegment] = useState<LeadSegment>('all');
  
  const { connections, isLoading: connectionsLoading, createConnection, removeConnection } = usePlatformConnections();
  const { smartLinks, isLoading: linksLoading, createSmartLink, removeSmartLink } = useSmartLinks();
  const { data: spotifyStats, isLoading: statsLoading } = useSpotifyStats();
  const { isConnected: shopifyConnected, isLoading: shopifyLoading } = useShopifyConnection();
  const { leads, isLoading: leadsLoading } = useSmartLinkLeads();
  const { counts: leadCounts, filterLeads, exportSegment } = useLeadSegments(leads);
  
  const filteredLeads = filterLeads(activeSegment);
  
  const handleExportSegment = (segment: LeadSegment) => {
    const count = exportSegment(segment);
    if (count) {
      toast.success(`Exported ${count} emails for Facebook Custom Audience`);
    } else {
      toast.error("No leads to export in this segment");
    }
  };

  // Handle Spotify OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('spotify_connected') === 'true') {
      toast.success("Spotify connected successfully!");
      // Clear the query parameter
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('error')) {
      toast.error(params.get('error') || "Connection failed");
      // Clear the query parameter
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Listen for messages from OAuth popup
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'spotify_connected') {
        toast.success("Spotify connected successfully!");
        // Force refresh the connections
        window.location.reload();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const getRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));
    
    if (diffInMinutes < 60) return `${diffInMinutes} minutes ago`;
    if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)} hours ago`;
    return `${Math.floor(diffInMinutes / 1440)} days ago`;
  };
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
          <h3 className="text-2xl font-semibold mb-6">Performance Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <MetricCard
              title="Total Plays"
              value={statsLoading ? "..." : spotifyStats ? `${(spotifyStats.totalPlays / 1000).toFixed(1)}K` : "Connect Spotify"}
              change={spotifyStats ? "+18% this week" : "No data"}
              icon={Play}
              trend="up"
            />
            <MetricCard
              title="Total Followers"
              value={statsLoading ? "..." : spotifyStats ? spotifyStats.followers.toLocaleString() : "Connect Spotify"}
              change={spotifyStats ? "+2.3K this week" : "No data"}
              icon={Users}
              trend="up"
            />
            <MetricCard
              title="Engagement Rate"
              value={statsLoading ? "..." : spotifyStats ? `${spotifyStats.engagementRate}%` : "Connect Spotify"}
              change={spotifyStats ? "+0.4% this week" : "No data"}
              icon={TrendingUp}
              trend="up"
            />
            <MetricCard
              title="Merch Sales"
              value={shopifyLoading ? "..." : shopifyConnected ? "Connected" : "Connect Shopify"}
              change={shopifyConnected ? "Store connected" : "No data"}
              icon={ShoppingBag}
              trend="up"
            />
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Connected Accounts */}
          <section className="lg:col-span-2">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-semibold">Connected Accounts</h3>
              <Button variant="outline" className="gap-2" onClick={() => setDialogOpen(true)}>
                <Plus className="w-4 h-4" />
                Connect Platform
              </Button>
            </div>
            <div className="grid gap-4">
              {connectionsLoading ? (
                <Card className="p-8 text-center bg-card/50 backdrop-blur-sm border-border">
                  <p className="text-muted-foreground">Loading connections...</p>
                </Card>
              ) : connections.length > 0 ? (
                connections.map((connection) => (
                  <ConnectedAccountCard
                    key={connection.id}
                    platform={connection.platform}
                    username={connection.username || "Unknown"}
                    status={connection.is_connected ? "connected" : "error"}
                    icon={platformIcons[connection.platform] || Music}
                    lastSync={connection.last_synced_at ? getRelativeTime(connection.last_synced_at) : "Never"}
                    url={connection.profile_url || "#"}
                    onRemove={() => removeConnection(connection.id)}
                    onEdit={() => {}}
                  />
                ))
              ) : (
                <Card className="p-8 text-center bg-card/50 backdrop-blur-sm border-border border-dashed">
                  <p className="text-muted-foreground mb-4">No platforms connected yet</p>
                  <Button onClick={() => setDialogOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Connect Your First Platform
                  </Button>
                </Card>
              )}
            </div>
          </section>

          {/* Smart Links */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-semibold">Smart Links</h3>
              <Button variant="outline" size="icon" onClick={() => setSmartLinkDialogOpen(true)}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-4">
              {linksLoading ? (
                <Card className="p-8 text-center bg-card/50 backdrop-blur-sm border-border">
                  <p className="text-muted-foreground">Loading links...</p>
                </Card>
              ) : smartLinks.length > 0 ? (
                smartLinks.map((link) => (
                  <SmartLinkCard
                    key={link.id}
                    title={link.title}
                    url={link.destination_url}
                    slug={link.slug}
                    clicks={link.click_count || 0}
                    conversions={link.conversion_count || 0}
                    onRemove={() => removeSmartLink(link.id)}
                    onEdit={() => {}}
                  />
                ))
              ) : (
                <Card className="p-8 text-center bg-card/50 backdrop-blur-sm border-border border-dashed">
                  <p className="text-muted-foreground mb-4">No smart links created yet</p>
                  <Button onClick={() => setSmartLinkDialogOpen(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Your First Smart Link
                  </Button>
                </Card>
              )}
            </div>
          </section>
        </div>

        {/* Email Leads & Retargeting */}
        <section className="mt-12 space-y-6">
          <h3 className="text-2xl font-semibold">Email Leads & Retargeting</h3>
          
          <UploadEvenCSV />
          
          <LeadFilters
            activeSegment={activeSegment}
            onSegmentChange={setActiveSegment}
            onExport={handleExportSegment}
            counts={leadCounts}
          />

          <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
            <h4 className="font-semibold mb-4">
              {activeSegment === 'all' ? 'All Leads' : 
               activeSegment === 'cold' ? 'Cold Leads' :
               activeSegment === 'album-only' ? 'Album Buyers' :
               activeSegment === 'merch-only' ? 'Merch Buyers' :
               'Super Fans'} ({filteredLeads.length})
            </h4>
            {leadsLoading ? (
              <p className="text-center text-muted-foreground">Loading leads...</p>
            ) : filteredLeads.length > 0 ? (
              <div className="space-y-4">
                {filteredLeads.map((lead: any) => (
                  <div key={lead.id} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="flex gap-1">
                        {lead.album_purchased && (
                          <div className="w-2 h-2 rounded-full bg-primary" title="Album purchased" />
                        )}
                        {lead.converted && (
                          <div className="w-2 h-2 rounded-full bg-success" title="Merch purchased" />
                        )}
                        {!lead.album_purchased && !lead.converted && (
                          <div className="w-2 h-2 rounded-full bg-warning" title="No purchases" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{lead.email}</p>
                        <p className="text-xs text-muted-foreground">
                          via {lead.smart_links?.title || 'Unknown'} • 
                          {lead.album_purchased && ' Album '}
                          {lead.converted && lead.album_purchased && '+ '}
                          {lead.converted && `Merch ($${lead.conversion_value})`}
                          {!lead.album_purchased && !lead.converted && ' No purchases yet'}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {getRelativeTime(lead.converted ? lead.converted_at : lead.album_purchased_at || lead.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground">No leads in this segment</p>
            )}
          </Card>
        </section>

        {/* Quick Actions */}
        <section className="mt-12 mb-8">
          <Card className="p-8 bg-gradient-gold text-primary-foreground">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-2xl font-bold mb-2">Ready to grow your fanbase?</h3>
                <p className="text-primary-foreground/80">
                  Create a new smart link or connect another platform to expand your reach
                </p>
              </div>
              <div className="flex gap-4">
                <Button size="lg" variant="secondary">
                  <LinkIcon className="w-5 h-5 mr-2" />
                  Create Smart Link
                </Button>
                <Button size="lg" variant="outline" className="bg-transparent border-primary-foreground text-primary-foreground hover:bg-primary-foreground hover:text-primary">
                  <Plus className="w-5 h-5 mr-2" />
                  Add Platform
                </Button>
              </div>
            </div>
          </Card>
        </section>
      </main>

      <AddPlatformDialog 
        open={dialogOpen} 
        onOpenChange={setDialogOpen}
        onConnect={createConnection}
      />

      <AddSmartLinkDialog
        open={smartLinkDialogOpen}
        onOpenChange={setSmartLinkDialogOpen}
        onAdd={createSmartLink}
      />
    </div>
  );
};

export default Index;
