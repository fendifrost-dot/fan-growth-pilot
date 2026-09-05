import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type FanStats = {
  total_leads: number;
  album_buyers: number;
  merch_converted: number;
  fan_tiers: { casual: number; engaged: number; superfan: number };
  platform_summary: Record<string, { followers?: number; streams?: number }>;
};

type LeadRow = {
  id: string;
  email: string | null;
  created_at: string;
  converted: boolean | null;
  album_purchased: boolean | null;
  smart_links?: { title?: string; slug?: string } | null;
};

type LeadsPayload = {
  leads: LeadRow[];
  segments: {
    cold: number;
    album_only: number;
    merch_only: number;
    both: number;
    total: number;
  };
};

const AdminFanLeads: React.FC = () => {
  const [stats, setStats] = useState<FanStats | null>(null);
  const [leads, setLeads] = useState<LeadsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, l] = await Promise.all([
        callHubFn<FanStats>("get_fan_stats", {}),
        callHubFn<LeadsPayload>("get_leads", {}),
      ]);
      setStats(s);
      setLeads(l);
    } catch (e) {
      const msg = (e as Error).message || "Failed to load fan reporting";
      setLoadError(msg);
      setStats(null);
      setLeads(null);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fan leads &amp; stats</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Smart-link capture reporting. Read-only operator view — no invented contacts.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {!loading && loadError && (
        <Card className="p-4 space-y-2">
          <p className="font-medium text-destructive">Fan leads could not be loaded</p>
          <p className="text-sm text-muted-foreground break-words">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
        </Card>
      )}
      {!loadError && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Total leads</p>
            <p className="text-2xl font-semibold">{stats.total_leads}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Album buyers</p>
            <p className="text-2xl font-semibold">{stats.album_buyers}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Merch converted</p>
            <p className="text-2xl font-semibold">{stats.merch_converted}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">Fan tiers</p>
            <p className="text-sm mt-1">
              C {stats.fan_tiers?.casual ?? 0} · E {stats.fan_tiers?.engaged ?? 0} · S{" "}
              {stats.fan_tiers?.superfan ?? 0}
            </p>
          </Card>
        </div>
      )}

      {stats?.platform_summary && Object.keys(stats.platform_summary).length > 0 && (
        <Card className="p-5 space-y-2">
          <h2 className="font-medium">Platform summary</h2>
          <ul className="text-sm space-y-1">
            {Object.entries(stats.platform_summary).map(([platform, row]) => (
              <li key={platform} className="flex gap-3">
                <Badge variant="outline">{platform}</Badge>
                <span className="text-muted-foreground">
                  followers {row.followers ?? 0} · streams {row.streams ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {leads?.segments && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {(
            [
              ["Total (page)", leads.segments.total],
              ["Cold", leads.segments.cold],
              ["Album only", leads.segments.album_only],
              ["Merch only", leads.segments.merch_only],
              ["Both", leads.segments.both],
            ] as const
          ).map(([label, n]) => (
            <Card key={label} className="p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold">{n}</p>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-5 overflow-x-auto">
        <h2 className="font-medium mb-3">Recent leads</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground border-b">
              <th className="p-2">Created</th>
              <th className="p-2">Email</th>
              <th className="p-2">Link</th>
              <th className="p-2">Flags</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="p-4 text-muted-foreground">Loading…</td></tr>
            )}
            {!loading && !(leads?.leads?.length) && (
              <tr><td colSpan={4} className="p-4 text-muted-foreground">No leads returned.</td></tr>
            )}
            {(leads?.leads ?? []).map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-2 text-xs whitespace-nowrap">
                  {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                </td>
                <td className="p-2">{r.email ?? "—"}</td>
                <td className="p-2 text-xs">
                  {r.smart_links?.title ?? r.smart_links?.slug ?? "—"}
                </td>
                <td className="p-2 flex flex-wrap gap-1">
                  {r.album_purchased ? <Badge>album</Badge> : null}
                  {r.converted ? <Badge variant="secondary">merch</Badge> : null}
                  {!r.album_purchased && !r.converted ? (
                    <Badge variant="outline">cold</Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminFanLeads;
