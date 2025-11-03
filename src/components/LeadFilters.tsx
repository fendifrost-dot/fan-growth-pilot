import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Download, Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type LeadSegment = 'all' | 'cold' | 'album-only' | 'merch-only' | 'both';

interface LeadFiltersProps {
  activeSegment: LeadSegment;
  onSegmentChange: (segment: LeadSegment) => void;
  onExport: (segment: LeadSegment) => void;
  counts: {
    all: number;
    cold: number;
    albumOnly: number;
    merchOnly: number;
    both: number;
  };
}

export const LeadFilters = ({ activeSegment, onSegmentChange, onExport, counts }: LeadFiltersProps) => {
  const segments = [
    { id: 'all' as LeadSegment, label: 'All Leads', count: counts.all, description: 'Everyone' },
    { id: 'cold' as LeadSegment, label: 'Cold Leads', count: counts.cold, description: 'No purchases yet' },
    { id: 'album-only' as LeadSegment, label: 'Album Buyers', count: counts.albumOnly, description: 'Bought album, no merch' },
    { id: 'merch-only' as LeadSegment, label: 'Merch Buyers', count: counts.merchOnly, description: 'Bought merch, no album' },
    { id: 'both' as LeadSegment, label: 'Super Fans', count: counts.both, description: 'Bought both' },
  ];

  return (
    <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Filter className="w-4 h-4" />
              <h4 className="font-semibold">Facebook Retargeting Segments</h4>
            </div>
            <p className="text-sm text-muted-foreground">
              Export segmented lists for Facebook Custom Audiences
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {segments.map((segment) => (
            <button
              key={segment.id}
              onClick={() => onSegmentChange(segment.id)}
              className={`p-4 rounded-lg border-2 text-left transition-all ${
                activeSegment === segment.id
                  ? 'border-primary bg-primary/10'
                  : 'border-border bg-background hover:border-primary/50'
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm font-medium">{segment.label}</span>
                <Badge variant={activeSegment === segment.id ? "default" : "secondary"}>
                  {segment.count}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{segment.description}</p>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            {activeSegment === 'cold' && "Target: Album purchase ads"}
            {activeSegment === 'album-only' && "Target: Merch store ads"}
            {activeSegment === 'merch-only' && "Target: Album purchase ads"}
            {activeSegment === 'both' && "Target: New releases & exclusives"}
            {activeSegment === 'all' && "All segments combined"}
          </p>
          <Button
            onClick={() => onExport(activeSegment)}
            disabled={counts[activeSegment === 'album-only' ? 'albumOnly' : activeSegment === 'merch-only' ? 'merchOnly' : activeSegment] === 0}
          >
            <Download className="w-4 h-4 mr-2" />
            Export for Facebook
          </Button>
        </div>
      </div>
    </Card>
  );
};
