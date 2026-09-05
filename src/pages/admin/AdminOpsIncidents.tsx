import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type Incident = {
  id: string;
  severity: string;
  category: string;
  title: string;
  status: string;
  created_at: string;
};

const AdminOpsIncidents: React.FC = () => {
  const [rows, setRows] = useState<Incident[]>([]);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("general");
  const [severity, setSeverity] = useState("info");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await callHubFn<{ rows: Incident[] }>("list_ops_incidents", { status: "all" });
      setRows(data.rows ?? []);
    } catch (e) {
      const msg = (e as Error).message || "Failed to load incidents";
      setLoadError(msg);
      setRows([]);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const log = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await callHubFn("log_ops_incident", {
        title: title.trim(),
        category,
        severity,
        detail: detail.trim() ? { note: detail.trim() } : {},
      });
      setTitle("");
      setDetail("");
      toast.success("Incident logged");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Log failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Ops incidents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Chief-of-Staff audit visibility. Log operational issues — never invent music or rights facts here.
        </p>
      </div>
      <Card className="p-5 space-y-3">
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Category</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div>
            <Label>Severity</Label>
            <Input value={severity} onChange={(e) => setSeverity(e.target.value)} />
          </div>
        </div>
        <Label>Detail</Label>
        <Textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
        <Button disabled={busy} onClick={() => void log()}>
          Log incident
        </Button>
      </Card>
      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">When</th>
              <th className="text-left p-3">Severity</th>
              <th className="text-left p-3">Title</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && loadError && (
              <tr>
                <td colSpan={8} className="p-3">
                  <p className="font-medium text-destructive">Incidents could not be loaded</p>
                  <p className="text-sm text-muted-foreground break-words">{loadError}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
                    Retry
                  </Button>
                </td>
              </tr>
            )}
            {!loading && !loadError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-3 text-muted-foreground">
                  No incidents logged yet.
                </td>
              </tr>
            )}
            {!loading && !loadError && rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                <td className="p-3">
                  <Badge variant="secondary">{r.severity}</Badge>
                </td>
                <td className="p-3">{r.title}</td>
                <td className="p-3 text-xs">{r.status}</td>
                <td className="p-3 text-right space-x-2">
                  {r.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void callHubFn("ack_ops_incident", { incident_id: r.id }).then(load)
                      }
                    >
                      Ack
                    </Button>
                  )}
                  {r.status !== "resolved" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void callHubFn("resolve_ops_incident", { incident_id: r.id }).then(load)
                      }
                    >
                      Resolve
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminOpsIncidents;
