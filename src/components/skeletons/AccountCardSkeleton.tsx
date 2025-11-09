import { Card } from "@/components/ui/card";

export const AccountCardSkeleton = () => {
  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1">
          <div className="w-12 h-12 rounded-lg bg-muted-foreground/20"></div>
          <div className="space-y-2 flex-1">
            <div className="h-5 w-32 bg-muted-foreground/20 rounded"></div>
            <div className="h-4 w-48 bg-muted-foreground/20 rounded"></div>
          </div>
        </div>
        <div className="h-8 w-20 bg-muted-foreground/20 rounded"></div>
      </div>
    </Card>
  );
};
