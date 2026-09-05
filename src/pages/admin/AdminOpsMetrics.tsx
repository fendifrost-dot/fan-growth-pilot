import React, { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type MetricRow = {
  key?: string;
  track_id: string;
  track_name?: string | null;
  agent?: string | null;
  discovered_today?: number;
  verified_today?: number;
  rejected_today?: number;
  drafts_today?: number;
  drafts_created_today?: number;
  drafts_approved_today?: number;
  drafts_rejected_today?: number;
  pitches_sent_today?: number;
  send_target?: number;
  supply_needed?: number;
  supply_required_to_target?: number;
  replies_received?: number;
  replies_awaiting_action?: number;
  placements_found?: number;
  placement_checks_overdue?: number;
  inbox_checks_overdue?: number;
  shortfall_reasons?: string[];
};

const AdminOpsMetrics: React.FC = () => {
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callHubFn<{
        rows?: MetricRow[];
        by_song?: MetricRow[];
        by_agent?: Array<MetricRow & { agent?: string }>;
      }>("get_playlist_ops_metrics", {});
      const songRows = (data.by_song ?? data.rows ?? []).map((r) => ({
        ...r,
        track_id: r.track_id || r.key || "unknown",
        discovered_today: r.discovered_today ?? 0,
        verified_today: r.verified_today ?? 0,
        drafts_created_today: r.drafts_created_today ?? r.drafts_today ?? 0,
        pitches_sent_today: r.pitches_sent_today ?? 0,
        send_target: r.send_target ?? 30,
        supply_needed: r.supply_needed ?? r.supply_required_to_target ?? 0,
      }));
      setRows(songRows);
    } catch (e) {
      setError((e as Error).message || "Failed to load ops metrics");
      setRows([]);
      toast.error((e as Error).message || "Failed to load ops metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Playlist ops metrics</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Daily discovery → verify → draft → approve → send → reply → placement by song and agent.
            Target: 30 sends per active song.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Track</th>
              <th className="text-left p-3">Agent</th>
              <th className="text-right p-3">Discovered</th>
              <th className="text-right p-3">Verified</th>
              <th className="text-right p-3">Drafts</th>
              <th className="text-right p-3">Sent</th>
              <th className="text-right p-3">Target</th>
              <th className="text-right p-3">Supply needed</th>
              <th className="text-right p-3">Replies</th>
              <th className="text-right p-3">Placements</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="p-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && error && (
              <tr>
                <td colSpan={10} className="p-3">
                  <p className="font-medium text-destructive">Metrics could not be loaded</p>
                  <p className="text-sm text-muted-foreground break-words">{error}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
                    Retry
                  </Button>
                </td>
              </tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="p-3 text-muted-foreground">
                  No playlist ops activity recorded yet today.
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              rows.map((r) => (
                <tr key={`${r.track_id}-${r.agent ?? "all"}`} className="border-t">
                  <td className="p-3 font-medium">{r.track_name ?? r.track_id.slice(0, 8)}</td>
                  <td className="p-3 text-xs">{r.agent ?? "—"}</td>
                  <td className="p-3 text-right">{r.discovered_today ?? 0}</td>
                  <td className="p-3 text-right">{r.verified_today ?? 0}</td>
                  <td className="p-3 text-right">{r.drafts_created_today ?? 0}</td>
                  <td className="p-3 text-right">{r.pitches_sent_today ?? 0}</td>
                  <td className="p-3 text-right">{r.send_target ?? 30}</td>
                  <td className="p-3 text-right">{r.supply_needed ?? 0}</td>
                  <td className="p-3 text-right">
                    {r.replies_received ?? 0}
                    {(r.replies_awaiting_action ?? 0) > 0
                      ? ` (${r.replies_awaiting_action} awaiting)`
                      : ""}
                  </td>
                  <td className="p-3 text-right">{r.placements_found ?? 0}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminOpsMetrics;
