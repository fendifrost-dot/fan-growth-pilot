import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type StationRun = {
  id: string;
  station_id: string;
  business_date_ct: string;
  status: string;
  actor_label: string;
  started_at: string;
  completed_at: string | null;
  upstream_run_id: string | null;
  input_batch_id: string | null;
  output_batch_id: string | null;
  raw_discoveries: number;
  unique_discoveries: number;
  verified_targets: number;
  drafts_created: number;
  duplicates: number;
  shortfall_reason: string | null;
  dependency_failure: string | null;
  error_summary: string | null;
};

type HandoffBatch = {
  id: string;
  batch_kind: string;
  queue_state: string;
  record_count: number;
  business_date_ct: string | null;
  created_at: string;
};

type OpsSetting = {
  setting_key: string;
  setting_value: Record<string, unknown>;
  description: string | null;
};

const STATION_LABELS: Record<string, string> = {
  playlist_discovery_begin: "04:30 — Playlist discovery begins",
  playlist_tranche_first: "07:00 — First playlist tranche ready",
  playlist_tranche_final: "08:30 — Final playlist tranche + sync discovery",
  sync_batch_ready: "12:00 — Sync batch ready",
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "running" || status === "partial") return "secondary";
  if (status === "failed" || status === "blocked") return "destructive";
  return "outline";
}

const AdminDailyOps: React.FC = () => {
  const [businessDate, setBusinessDate] = useState("");
  const [runs, setRuns] = useState<StationRun[]>([]);
  const [batches, setBatches] = useState<HandoffBatch[]>([]);
  const [settings, setSettings] = useState<OpsSetting[]>([]);
  const [timezone, setTimezone] = useState("America/Chicago");
  const [loading, setLoading] = useState(true);
  const [activeSongs, setActiveSongs] = useState("1");
  const [capacity, setCapacity] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dash = await callHubFn<{
        business_date_ct: string;
        timezone: string;
        runs: StationRun[];
        handoff_batches: HandoffBatch[];
        settings: OpsSetting[];
      }>("get_daily_ops_dashboard", businessDate ? { business_date_ct: businessDate } : {});
      setBusinessDate(dash.business_date_ct);
      setTimezone(dash.timezone || "America/Chicago");
      setRuns(dash.runs ?? []);
      setBatches(dash.handoff_batches ?? []);
      setSettings(dash.settings ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load daily ops");
    } finally {
      setLoading(false);
    }
  }, [businessDate]);

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — initial load only

  const refreshCapacity = async () => {
    try {
      const res = await callHubFn<{ plan: Record<string, unknown> }>("get_discovery_capacity_plan", {
        active_pitching_songs: Number(activeSongs) || 0,
      });
      setCapacity(res.plan ?? null);
    } catch (e) {
      toast.error((e as Error).message || "Capacity plan failed");
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Daily Operations</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Claude station ledger and Grok handoff queues · wall-clock {timezone}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="biz-date">Business date (CT)</Label>
            <Input
              id="biz-date"
              type="date"
              value={businessDate}
              onChange={(e) => setBusinessDate(e.target.value)}
              className="w-44"
            />
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <Card className="p-5">
        <h2 className="font-medium">Station runs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Idempotent per station + CT date. Upstream failures are recorded; safe work may continue.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground mt-4">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-4">No station runs for this date yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {runs.map((r) => (
              <div key={r.id} className="border rounded-md p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 justify-between">
                  <span className="font-medium">
                    {STATION_LABELS[r.station_id] ?? r.station_id}
                  </span>
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-muted-foreground">
                  <span>Actor: {r.actor_label}</span>
                  <span>Raw: {r.raw_discoveries}</span>
                  <span>Unique: {r.unique_discoveries}</span>
                  <span>Verified: {r.verified_targets}</span>
                  <span>Drafts: {r.drafts_created}</span>
                  <span>Dupes: {r.duplicates}</span>
                  <span>In batch: {r.input_batch_id ? r.input_batch_id.slice(0, 8) : "—"}</span>
                  <span>Out batch: {r.output_batch_id ? r.output_batch_id.slice(0, 8) : "—"}</span>
                </div>
                {r.dependency_failure && (
                  <p className="mt-2 text-amber-700 dark:text-amber-400">
                    Dependency: {r.dependency_failure}
                  </p>
                )}
                {r.shortfall_reason && (
                  <p className="mt-1 text-muted-foreground">Shortfall: {r.shortfall_reason}</p>
                )}
                {r.error_summary && (
                  <p className="mt-1 text-destructive">Error: {r.error_summary}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Grok handoff queues</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Machine-readable states from CLAUDE_BATCH_READY → IMPORTED_TO_AGH
        </p>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-4">No handoff batches for this date.</p>
        ) : (
          <ul className="mt-4 space-y-2 text-sm">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 justify-between border rounded-md px-3 py-2">
                <span>
                  {b.batch_kind} · {b.record_count} records · {b.id.slice(0, 8)}
                </span>
                <Badge variant="outline">{b.queue_state}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-medium">Discovery capacity</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Planning floors live in ops_settings — not code constants.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="active-songs">Active pitching songs</Label>
            <Input
              id="active-songs"
              value={activeSongs}
              onChange={(e) => setActiveSongs(e.target.value)}
              className="w-28"
            />
          </div>
          <Button variant="outline" onClick={() => void refreshCapacity()}>
            Compute plan
          </Button>
        </div>
        {capacity && (
          <pre className="mt-3 text-xs bg-muted/50 p-3 rounded-md overflow-auto">
            {JSON.stringify(capacity, null, 2)}
          </pre>
        )}
        {settings.length > 0 && (
          <div className="mt-4 space-y-2 text-sm">
            {settings.map((s) => (
              <div key={s.setting_key} className="border rounded-md p-3">
                <div className="font-medium">{s.setting_key}</div>
                {s.description && (
                  <p className="text-muted-foreground text-xs mt-1">{s.description}</p>
                )}
                <pre className="mt-2 text-xs overflow-auto">
                  {JSON.stringify(s.setting_value, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="text-sm text-muted-foreground">
        Related:{" "}
        <Link to="/admin/discovery-profiles" className="underline">
          Discovery profiles
        </Link>{" "}
        ·{" "}
        <Link to="/admin/outreach" className="underline">
          Curator drafts
        </Link>{" "}
        ·{" "}
        <Link to="/admin/licensing" className="underline">
          Licensing
        </Link>
      </p>
    </div>
  );
};

export default AdminDailyOps;
