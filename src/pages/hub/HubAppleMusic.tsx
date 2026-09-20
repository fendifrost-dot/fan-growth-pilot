import React from "react";
import { Apple, Radio, MapPin, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAppleMusic } from "@/hooks/useAppleMusic";
import {
  PageHeader,
  StatTile,
  HubLoading,
  HubEmpty,
  compactNumber,
} from "@/components/hub/HubPrimitives";

const HubAppleMusic: React.FC = () => {
  const { data, isLoading, error, refetch } = useAppleMusic();

  const hasData = !!data && (data.stations.length > 0 || data.cities.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Apple Music"
        description="Radio airplay across Apple Music / broadcast stations, plus your listening geography."
        actions={
          data?.profileUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={data.profileUrl} target="_blank" rel="noreferrer" className="gap-2">
                <ExternalLink className="w-4 h-4" />
                Open profile
              </a>
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <HubLoading label="Loading Apple Music airplay…" />
      ) : error ? (
        <HubEmpty
          icon={Apple}
          title="Couldn't load Apple Music data"
          description="Try again shortly."
          action={
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      ) : !hasData ? (
        <>
          <HubEmpty
            icon={Apple}
            title="No Apple Music airplay yet"
            description="Radio-spin snapshots (stations & cities) will appear here once the weekly Apple Music for Artists data has been ingested."
          />
          <Card className="p-5 bg-muted/30 border-border">
            <div className="flex gap-3">
              <Info className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-sm text-muted-foreground">
                Apple doesn't expose streaming counts the way Spotify does, so this
                section tracks <strong>radio airplay</strong> — which stations and
                cities are spinning your songs — sourced from Apple Music for Artists.
              </p>
            </div>
          </Card>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile
              label="Total spins"
              value={compactNumber(data!.totalSpins)}
              sub="This snapshot"
              icon={Radio}
            />
            <StatTile
              label="Stations"
              value={data!.stations.length}
              sub="Spinning your catalog"
              icon={Radio}
            />
            <StatTile
              label="Cities"
              value={data!.cities.length}
              sub="With airplay"
              icon={MapPin}
            />
          </div>

          {data!.latestWeek && (
            <p className="text-xs text-muted-foreground">
              Snapshot week: {new Date(data!.latestWeek).toLocaleDateString()}
            </p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="p-5 bg-card/50 border-border">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" /> Top stations
              </h3>
              <div className="space-y-2">
                {data!.stations.map((s, i) => (
                  <div
                    key={`${s.station_call_sign}-${i}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium">
                        {s.station_call_sign || "Unknown station"}
                      </span>
                      {(s.city || s.country_code) && (
                        <span className="text-muted-foreground ml-2">
                          {[s.city, s.country_code].filter(Boolean).join(", ")}
                        </span>
                      )}
                    </div>
                    <Badge variant="secondary">{compactNumber(s.spins_total)}</Badge>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5 bg-card/50 border-border">
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-primary" /> Top cities
              </h3>
              <div className="space-y-2">
                {data!.cities.map((c, i) => (
                  <div
                    key={`${c.city}-${i}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {c.city || c.area_name || "Unknown"}
                      {c.country_code && (
                        <span className="text-muted-foreground ml-2">{c.country_code}</span>
                      )}
                    </span>
                    <Badge variant="secondary">{compactNumber(c.spins_total ?? 0)}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
};

export default HubAppleMusic;
