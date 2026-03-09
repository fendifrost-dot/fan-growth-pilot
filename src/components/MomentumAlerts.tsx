import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, AlertTriangle, Info } from "lucide-react";
import { useMomentumEvents } from "@/hooks/useMomentumEvents";

export const MomentumAlerts = () => {
  const { events, isLoading } = useMomentumEvents();

  if (isLoading) {
    return (
      <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
        <div className="h-6 w-48 bg-muted-foreground/20 rounded mb-4" />
        <div className="h-20 bg-muted-foreground/20 rounded" />
      </Card>
    );
  }

  if (events.length === 0) {
    return (
      <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
        <h4 className="font-semibold mb-2">Momentum Alerts</h4>
        <p className="text-sm text-muted-foreground">
          No momentum events detected yet. Run the intelligence engine after your next Chartmetric scrape to detect changes.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
      <h4 className="font-semibold mb-4">Recent Momentum Alerts</h4>
      <div className="space-y-3">
        {events.slice(0, 8).map((event) => {
          const isPositive = (event.absolute_change || 0) > 0;
          const Icon = event.severity === 'critical' 
            ? (isPositive ? TrendingUp : AlertTriangle)
            : event.severity === 'warning'
            ? (isPositive ? TrendingUp : TrendingDown)
            : Info;
          
          const severityColor = {
            critical: isPositive ? 'text-success' : 'text-destructive',
            warning: isPositive ? 'text-warning' : 'text-destructive',
            info: 'text-info',
          }[event.severity] || 'text-muted-foreground';

          const label = event.metric_name.replace(/_/g, ' ');
          const pct = event.percent_change ? `${event.percent_change > 0 ? '+' : ''}${event.percent_change.toFixed(1)}%` : '';
          const abs = event.absolute_change ? `${event.absolute_change > 0 ? '+' : ''}${event.absolute_change.toLocaleString()}` : '';

          return (
            <div key={event.id} className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${severityColor}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium capitalize">{label}</span>
                  {pct && <Badge variant="outline" className="text-xs">{pct}</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {abs && `Change: ${abs}`}
                  {event.related_city && ` • ${event.related_city}`}
                  {` • ${new Date(event.detected_at).toLocaleDateString()}`}
                </p>
              </div>
              <SeverityBadge severity={event.severity} />
            </div>
          );
        })}
      </div>
    </Card>
  );
};

const SeverityBadge = ({ severity }: { severity: string }) => {
  const styles: Record<string, string> = {
    critical: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-info/10 text-info',
  };
  return (
    <Badge className={`text-xs ${styles[severity] || styles.info}`}>
      {severity}
    </Badge>
  );
};
