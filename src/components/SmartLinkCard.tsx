import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";

interface SmartLinkCardProps {
  title: string;
  url: string;
  clicks: number;
  conversions: number;
}

export const SmartLinkCard = ({ title, url, clicks, conversions }: SmartLinkCardProps) => {
  const copyToClipboard = () => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard!");
  };

  return (
    <Card className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold">{title}</h4>
        <ExternalLink className="w-4 h-4 text-muted-foreground" />
      </div>
      
      <div className="flex items-center gap-2 mb-4 p-2 bg-muted rounded-lg">
        <code className="text-sm flex-1 truncate">{url}</code>
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
