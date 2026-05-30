import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type PitchRow = {
  id: string;
  playlist_id: string | null;
  track_name: string;
  curator_email: string | null;
  method: string | null;
  status: string | null;
  pitched_at: string | null;
  sent_at: string | null;
  cooldown_until: string | null;
};

const AdminPitchLog: React.FC = () => {
  const [rows, setRows] = useState<PitchRow[]>([]);
  const [summary, setSummary] = useState<{ email_pitches_last_24h?: number }>({});
  const [trackFilter, setTrackFilter] = useState("Designed For Me (Control)");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: PitchRow[]; summary?: { email_pitches_last_24h?: number } }>(
        "get_pitch_log",
        { track_name: trackFilter.trim() || undefined, limit: 100 },
      );
      setRows(data.rows ?? []);
      setSummary(data.summary ?? {});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load pitch log");
    } finally {
      setLoading(false);
    }
  }, [trackFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Curator pitch log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Audit trail for playlist submission emails (cooldowns, double-pitch prevention). Fan blasts live under{" "}
          <Link to="/admin/campaigns" className="underline">Campaigns</Link>.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs text-muted-foreground">Filter by track</label>
          <Input className="mt-1 w-72" value={trackFilter} onChange={(e) => setTrackFilter(e.target.value)} />
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          Refresh
        </Button>
        <div className="text-sm pb-1">
          <span className="text-muted-foreground">Emails sent (24h):</span>{" "}
          <strong>{summary.email_pitches_last_24h ?? 0}</strong>
        </div>
      </Card>

      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">When</th>
              <th className="text-left p-3">Track</th>
              <th className="text-left p-3">Playlist</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Cooldown until</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6 text-muted-foreground text-center">
                  No pitches logged yet. Send from{" "}
                  <Link to="/admin/outreach" className="underline">Outreach</Link> after approving a draft.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-3 text-xs whitespace-nowrap">
                    {new Date(r.pitched_at || r.sent_at || "").toLocaleString()}
                  </td>
                  <td className="p-3">{r.track_name}</td>
                  <td className="p-3 font-mono text-xs max-w-[200px] truncate" title={r.playlist_id ?? ""}>
                    {r.playlist_id ?? "—"}
                  </td>
                  <td className="p-3">{r.curator_email ?? "—"}</td>
                  <td className="p-3">{r.status ?? "—"} / {r.method ?? "—"}</td>
                  <td className="p-3 text-xs">
                    {r.cooldown_until ? new Date(r.cooldown_until).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminPitchLog;
