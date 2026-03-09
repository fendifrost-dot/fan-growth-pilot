import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, Target, Gift, FileText, Mail, MapPin } from "lucide-react";
import { useMarketingActions } from "@/hooks/useMarketingActions";

const ACTION_ICONS: Record<string, React.ElementType> = {
  geo_ad_recommendation: MapPin,
  retargeting_recommendation: Target,
  superfan_offer: Gift,
  content_prompt: FileText,
  email_campaign_recommendation: Mail,
  curator_outreach_recommendation: Lightbulb,
};

const PRIORITY_STYLES: Record<string, string> = {
  high: 'bg-destructive/10 text-destructive',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-info/10 text-info',
};

export const MarketingRecommendations = () => {
  const { actions, isLoading } = useMarketingActions();

  if (isLoading) {
    return (
      <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
        <div className="h-6 w-48 bg-muted-foreground/20 rounded mb-4" />
        <div className="h-20 bg-muted-foreground/20 rounded" />
      </Card>
    );
  }

  const pending = actions.filter(a => a.status === 'pending');

  if (pending.length === 0) {
    return (
      <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
        <h4 className="font-semibold mb-2">Marketing Recommendations</h4>
        <p className="text-sm text-muted-foreground">
          No pending recommendations. Run the intelligence engine to generate actionable insights.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-semibold">Marketing Recommendations</h4>
        <Badge variant="outline">{pending.length} pending</Badge>
      </div>
      <div className="space-y-3">
        {pending.slice(0, 6).map((action) => {
          const Icon = ACTION_ICONS[action.action_type] || Lightbulb;
          return (
            <div key={action.id} className="flex items-start gap-3 p-3 rounded-lg bg-background/50">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm">{action.recommendation_text}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {action.related_city && `${action.related_city} • `}
                  {new Date(action.created_at).toLocaleDateString()}
                </p>
              </div>
              <Badge className={`text-xs flex-shrink-0 ${PRIORITY_STYLES[action.priority] || PRIORITY_STYLES.medium}`}>
                {action.priority}
              </Badge>
            </div>
          );
        })}
      </div>
    </Card>
  );
};
