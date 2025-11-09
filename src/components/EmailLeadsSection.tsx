import { useState } from "react";
import { Card } from "@/components/ui/card";
import { UploadEvenCSV } from "@/components/UploadEvenCSV";
import { LeadFilters } from "@/components/LeadFilters";
import { useSmartLinkLeads } from "@/hooks/useSmartLinkLeads";
import { useLeadSegments, type LeadSegment } from "@/hooks/useLeadSegments";
import { toast } from "sonner";

export const EmailLeadsSection = () => {
  const [activeSegment, setActiveSegment] = useState<LeadSegment>('all');
  const { leads } = useSmartLinkLeads();
  const { counts, exportSegment } = useLeadSegments(leads);
  
  const handleExportSegment = (segment: LeadSegment) => {
    const count = exportSegment(segment);
    if (count) {
      toast.success(`Exported ${count} emails for Facebook Custom Audience`);
    } else {
      toast.error("No leads to export in this segment");
    }
  };

  const getRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  };

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Email Leads & Retargeting</h2>
        <p className="text-muted-foreground">Upload EVEN album purchases and segment your audience for Facebook ads</p>
      </div>

      <div className="grid gap-6">
        <UploadEvenCSV />
        
        <LeadFilters
          activeSegment={activeSegment}
          onSegmentChange={setActiveSegment}
          onExport={handleExportSegment}
          counts={counts}
        />

        <Card className="p-6 bg-card/50 backdrop-blur-sm border-border">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Recent Activity</h3>
              <span className="text-sm text-muted-foreground">
                {leads.length} total leads captured
              </span>
            </div>
            
            {leads.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No leads captured yet. Share your smart links to start collecting leads!</p>
              </div>
            ) : (
              <div className="space-y-2">
                {leads.slice(0, 5).map((lead) => (
                  <div key={lead.id} className="flex items-center justify-between p-3 rounded-lg bg-background/50">
                    <div className="flex-1">
                      <p className="font-medium">{lead.email}</p>
                      <p className="text-sm text-muted-foreground">
                        {lead.smart_links?.title || 'Unknown Link'} • {getRelativeTime(lead.created_at)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {lead.album_purchased && (
                        <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                          Album
                        </span>
                      )}
                      {lead.converted && (
                        <span className="px-2 py-1 text-xs rounded-full bg-success/10 text-success">
                          Merch
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </section>
  );
};
