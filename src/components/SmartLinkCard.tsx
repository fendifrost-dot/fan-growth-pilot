import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, Copy, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface SmartLinkCardProps {
  title: string;
  url: string;
  slug: string;
  clicks: number;
  conversions: number;
  onRemove?: () => void;
  onEdit?: () => void;
}

export const SmartLinkCard = ({ title, url, slug, clicks, conversions, onRemove, onEdit }: SmartLinkCardProps) => {
  const smartLinkUrl = `${window.location.origin}/${slug}`;
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(smartLinkUrl);
    toast.success("Link copied to clipboard!");
  };

  return (
    <Card className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold">{title}</h4>
        <div className="flex items-center gap-2">
          {onEdit && (
            <Button size="icon" variant="ghost" onClick={onEdit}>
              <Edit className="w-4 h-4" />
            </Button>
          )}
          {onRemove && (
            <Button size="icon" variant="ghost" onClick={onRemove}>
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>
      
      <div className="flex items-center gap-2 mb-4 p-2 bg-muted rounded-lg">
        <code className="text-sm flex-1 truncate">{smartLinkUrl}</code>
        <Button size="icon" variant="ghost" onClick={copyToClipboard}>
          <Copy className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Clicks</p>
          <p className="text-2xl font-bold">{clicks.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Conversions</p>
          <p className="text-2xl font-bold">{conversions}</p>
        </div>
      </div>
    </Card>
  );
};
