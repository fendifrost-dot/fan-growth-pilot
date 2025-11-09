import { Card } from "@/components/ui/card";

export const MetricCardSkeleton = () => {
  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <div className="h-4 w-24 bg-muted-foreground/20 rounded"></div>
          <div className="h-8 w-20 bg-muted-foreground/20 rounded"></div>
          <div className="h-4 w-16 bg-muted-foreground/20 rounded"></div>
        </div>
        <div className="w-12 h-12 rounded-lg bg-primary/10 animate-pulse"></div>
      </div>
    </Card>
  );
};
