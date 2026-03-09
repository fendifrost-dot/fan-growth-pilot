import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Star, Zap } from "lucide-react";
import { useFanProfiles, type FanTierCounts } from "@/hooks/useFanProfiles";

export const FanDatabaseOverview = () => {
  const { fans, tierCounts, isLoading } = useFanProfiles();

  if (isLoading) {
    return (
      <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
        <div className="h-6 w-48 bg-muted-foreground/20 rounded mb-4" />
        <div className="h-20 bg-muted-foreground/20 rounded" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tier Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <TierCard label="Total Fans" count={tierCounts.total} icon={Users} color="text-primary" />
        <TierCard label="Casual" count={tierCounts.casual} icon={Users} color="text-muted-foreground" />
        <TierCard label="Engaged" count={tierCounts.engaged} icon={Zap} color="text-warning" />
        <TierCard label="Superfans" count={tierCounts.superfan} icon={Star} color="text-success" />
      </div>

      {/* Top Fans */}
      {fans.length > 0 && (
        <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
          <h4 className="font-semibold mb-4">Top Fans by Score</h4>
          <div className="space-y-2">
            {fans.slice(0, 8).map((fan) => (
              <div key={fan.id} className="flex items-center justify-between p-3 rounded-lg bg-background/50">
                <div className="flex-1">
                  <p className="font-medium text-sm">{fan.email || 'Anonymous'}</p>
                  <p className="text-xs text-muted-foreground">
                    {fan.total_purchases > 0 ? `${fan.total_purchases} purchase(s)` : ''} 
                    {fan.city ? ` • ${fan.city}` : ''}
                    {fan.first_song ? ` • via ${fan.first_song}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold">{fan.fan_score}</span>
                  <TierBadge tier={fan.fan_tier} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

const TierCard = ({ label, count, icon: Icon, color }: { label: string; count: number; icon: React.ElementType; color: string }) => (
  <Card className="p-4 bg-card/50 backdrop-blur-sm border-border">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
        <Icon className={`w-5 h-5 ${color}`} />
      </div>
      <div>
        <p className="text-2xl font-bold">{count}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  </Card>
);

const TierBadge = ({ tier }: { tier: string }) => {
  const variants: Record<string, string> = {
    superfan: 'bg-success/10 text-success',
    engaged: 'bg-warning/10 text-warning',
    casual: 'bg-muted text-muted-foreground',
  };
  return (
    <Badge className={`text-xs ${variants[tier] || variants.casual}`}>
      {tier}
    </Badge>
  );
};
