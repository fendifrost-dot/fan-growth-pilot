import React from "react";
import { Link } from "react-router-dom";
import { Instagram, Facebook, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useArtistStats } from "@/hooks/useArtistStats";
import {
  PageHeader,
  StatTile,
  HubLoading,
  compactNumber,
} from "@/components/hub/HubPrimitives";

const SOCIAL_TOOLS = [
  {
    label: "Curator IG outreach",
    to: "/admin/ig-queue",
    description: "Queue and send curator DMs (mutual-follow gated)",
  },
  {
    label: "IG roster",
    to: "/admin/ig-roster",
    description: "Verify follow-backs before queuing DMs",
  },
  {
    label: "Fan IG outreach",
    to: "/admin/fan-ig-queue",
    description: "Direct fan engagement DMs",
  },
];

const HubSocial: React.FC = () => {
  const { stats, isLoading } = useArtistStats();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social"
        description="Instagram & Facebook reach, plus the outreach tools that turn followers into fans."
      />

      {isLoading ? (
        <HubLoading label="Loading social stats…" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <StatTile
            label="Instagram followers"
            value={stats ? compactNumber(stats.instagram.followers) : "—"}
            icon={Instagram}
          />
          <StatTile
            label="Facebook followers"
            value={stats ? compactNumber(stats.facebook.followers) : "—"}
            icon={Facebook}
          />
        </div>
      )}

      <section>
        <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" /> Outreach tools
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SOCIAL_TOOLS.map((tool) => (
            <Card key={tool.to} className="p-5 bg-card/50 border-border">
              <p className="font-medium">{tool.label}</p>
              <p className="text-sm text-muted-foreground mt-1">{tool.description}</p>
              <Button variant="ghost" size="sm" className="mt-3 -ml-2" asChild>
                <Link to={tool.to}>
                  Open <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
};

export default HubSocial;
