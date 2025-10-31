import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LucideIcon } from "lucide-react";

interface ConnectedAccountCardProps {
  platform: string;
  username: string;
  status: "connected" | "syncing" | "error";
  icon: LucideIcon;
  lastSync?: string;
}

export const ConnectedAccountCard = ({ 
  platform, 
  username, 
  status, 
  icon: Icon,
  lastSync 
}: ConnectedAccountCardProps) => {
  const statusColors = {
    connected: "bg-success/20 text-success",
    syncing: "bg-warning/20 text-warning",
    error: "bg-destructive/20 text-destructive"
  };

  return (
    <Card className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center">
          <Icon className="w-6 h-6 text-primary" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold">{platform}</h4>
          <p className="text-sm text-muted-foreground">@{username}</p>
        </div>
        <div className="text-right">
          <Badge className={statusColors[status]}>
            {status}
          </Badge>
          {lastSync && (
            <p className="text-xs text-muted-foreground mt-1">{lastSync}</p>
          )}
        </div>
      </div>
    </Card>
  );
};
