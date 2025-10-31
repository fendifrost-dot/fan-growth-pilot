import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LucideIcon, ExternalLink, Trash2, Edit } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical } from "lucide-react";

interface ConnectedAccountCardProps {
  platform: string;
  username: string;
  status: "connected" | "syncing" | "error";
  icon: LucideIcon;
  lastSync?: string;
  url?: string;
  onRemove?: () => void;
  onEdit?: () => void;
}

export const ConnectedAccountCard = ({ 
  platform, 
  username, 
  status, 
  icon: Icon,
  lastSync,
  url,
  onRemove,
  onEdit
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
        <div className="flex-1 min-w-0">
          <h4 className="font-semibold">{platform}</h4>
          <p className="text-sm text-muted-foreground">@{username}</p>
          {url && (
            <a 
              href={url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1 mt-1"
            >
              View profile
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <Badge className={statusColors[status]}>
              {status}
            </Badge>
            {lastSync && (
              <p className="text-xs text-muted-foreground mt-1">{lastSync}</p>
            )}
          </div>
          
          {(onRemove || onEdit) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onEdit && (
                  <DropdownMenuItem onClick={onEdit}>
                    <Edit className="w-4 h-4 mr-2" />
                    Edit
                  </DropdownMenuItem>
                )}
                {onRemove && (
                  <DropdownMenuItem onClick={onRemove} className="text-destructive">
                    <Trash2 className="w-4 h-4 mr-2" />
                    Remove
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </Card>
  );
};
