import { Card } from "@/components/ui/card";

export const SmartLinkCardSkeleton = () => {
  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border animate-pulse">
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <div className="h-6 w-48 bg-muted-foreground/20 rounded"></div>
            <div className="h-4 w-64 bg-muted-foreground/20 rounded"></div>
          </div>
          <div className="h-8 w-8 bg-muted-foreground/20 rounded"></div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <div className="h-3 w-12 bg-muted-foreground/20 rounded"></div>
            <div className="h-5 w-16 bg-muted-foreground/20 rounded"></div>
          </div>
          <div className="space-y-1">
            <div className="h-3 w-16 bg-muted-foreground/20 rounded"></div>
            <div className="h-5 w-12 bg-muted-foreground/20 rounded"></div>
          </div>
          <div className="space-y-1">
            <div className="h-3 w-20 bg-muted-foreground/20 rounded"></div>
            <div className="h-5 w-16 bg-muted-foreground/20 rounded"></div>
          </div>
        </div>
      </div>
    </Card>
  );
};
