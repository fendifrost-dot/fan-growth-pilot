import { useState } from "react";
import { DashboardHeader } from "@/components/DashboardHeader";
import { MetricCard } from "@/components/MetricCard";
import { ConnectedAccountCard } from "@/components/ConnectedAccountCard";
import { SmartLinkCard } from "@/components/SmartLinkCard";
import { AddPlatformDialog, PlatformAccount } from "@/components/AddPlatformDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  Link as LinkIcon
} from "lucide-react";
import { toast } from "sonner";

const Index = () => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connectedAccounts, setConnectedAccounts] = useState<PlatformAccount[]>([
    {
      id: "1",
      platform: "Spotify",
      username: "bemoremodest",
      url: "https://open.spotify.com/artist/example",
      status: "connected",
      icon: Music,
      lastSync: "2 hours ago"
    },
    {
      id: "2",
      platform: "Instagram",
      username: "bemoremodest",
      url: "https://instagram.com/bemoremodest",
      status: "connected",
      icon: Instagram,
      lastSync: "1 hour ago"
    },
    {
      id: "3",
      platform: "YouTube",
      username: "bemoremodest",
      url: "https://youtube.com/@bemoremodest",
      status: "syncing",
      icon: Youtube,
      lastSync: "syncing..."
    },
    {
      id: "4",
      platform: "Facebook",
      username: "bemoremodest",
      url: "https://facebook.com/bemoremodest",
      status: "connected",
      icon: Facebook,
      lastSync: "3 hours ago"
    }
  ]);

  const handleAddPlatform = (account: PlatformAccount) => {
    setConnectedAccounts([...connectedAccounts, account]);
  };

  const handleRemoveAccount = (id: string) => {
    setConnectedAccounts(connectedAccounts.filter(acc => acc.id !== id));
    toast.success("Account disconnected");
  };

  const handleEditAccount = (id: string) => {
    toast.info("Edit functionality - coming soon!");
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
              value="2.4M"
              change="+18% this week"
              icon={Play}
              trend="up"
            />
            <MetricCard
              title="Total Followers"
              value="156K"
              change="+2.3K this week"
              icon={Users}
              trend="up"
            />
            <MetricCard
              title="Engagement Rate"
              value="8.2%"
              change="+0.4% this week"
              icon={TrendingUp}
              trend="up"
            />
            <MetricCard
              title="Merch Sales"
              value="$12.4K"
              change="+25% this month"
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
              {connectedAccounts.length > 0 ? (
                connectedAccounts.map((account) => (
                  <ConnectedAccountCard
                    key={account.id}
                    platform={account.platform}
                    username={account.username}
                    status={account.status}
                    icon={account.icon}
                    lastSync={account.lastSync}
                    url={account.url}
                    onRemove={() => handleRemoveAccount(account.id)}
                    onEdit={() => handleEditAccount(account.id)}
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
              <Button variant="outline" size="icon">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-4">
              <SmartLinkCard
                title="New Album Drop"
                url="go.bemoremodest.com/album"
                clicks={15420}
                conversions={1230}
              />
              <SmartLinkCard
                title="Merch Collection"
                url="go.bemoremodest.com/merch"
                clicks={8940}
                conversions={542}
              />
              <SmartLinkCard
                title="Tour Tickets"
                url="go.bemoremodest.com/tour"
                clicks={22100}
                conversions={1890}
              />
            </div>
          </section>
        </div>

        {/* Recent Activity */}
        <section className="mt-12">
          <h3 className="text-2xl font-semibold mb-6">Recent Activity</h3>
          <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
            <div className="space-y-4">
              {[
                { action: "New follower on Instagram", time: "2 minutes ago", type: "success" },
                { action: "Smart link clicked 152 times", time: "15 minutes ago", type: "info" },
                { action: "3 new merch purchases", time: "1 hour ago", type: "success" },
                { action: "Spotify playlist added your track", time: "3 hours ago", type: "info" },
                { action: "Facebook ad performance improved", time: "5 hours ago", type: "success" }
              ].map((activity, index) => (
                <div key={index} className="flex items-center justify-between py-3 border-b border-border last:border-0">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      activity.type === "success" ? "bg-success" : "bg-info"
                    }`} />
                    <p className="text-sm">{activity.action}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{activity.time}</span>
                </div>
              ))}
            </div>
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
        onAdd={handleAddPlatform}
      />
    </div>
  );
};

export default Index;
