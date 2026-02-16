import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, Copy, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getCanonicalUrl, DEFAULT_OG_IMAGE } from "@/lib/constants";

interface SmartLinkCardProps {
  title: string;
  url: string;
  slug: string;
  shortCode?: string;
  clicks: number;
  conversions: number;
  ogImageUrl?: string | null;
  onRemove?: () => void;
  onEdit?: () => void;
}

export const SmartLinkCard = ({ title, slug, ogImageUrl, clicks, conversions, onRemove, onEdit }: SmartLinkCardProps) => {
  const canonicalUrl = getCanonicalUrl(slug);
  const thumbnailSrc = ogImageUrl || DEFAULT_OG_IMAGE;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(canonicalUrl);
    toast.success("Link copied to clipboard!");
  };

  return (
    <Card className="p-4 bg-card/50 backdrop-blur-sm border-border hover:shadow-glow transition-all duration-300">
      {/* Thumbnail preview */}
      <div className="w-full aspect-[1200/630] rounded-md overflow-hidden mb-3 bg-muted">
        <img
          src={thumbnailSrc}
          alt={`${title} preview`}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      </div>

      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold truncate">{title}</h4>
        <div className="flex items-center gap-1">
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
        </div>
      </div>
      
      {/* Canonical URL — single display + copy */}
      <div className="flex items-center gap-2 mb-3 p-2 bg-muted rounded-lg" data-testid="canonical-url">
        <code className="text-sm flex-1 truncate">{canonicalUrl}</code>
        <Button size="icon" variant="ghost" onClick={copyToClipboard} aria-label="Copy link">
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
