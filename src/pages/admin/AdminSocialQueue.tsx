import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type QueueRow = {
  id: string;
  platform: string;
  action: string;
  target_url: string;
  draft_text: string | null;
  operator_brief: string | null;
  dm_ref: string | null;
  ig_handle: string | null;
  playlist_id: string | null;
  status: string;
  created_at: string;
  result?: {
    engagement_type?: string;
    featuring?: string[];
    pitch_track?: string;
    pitch_reason?: string;
    mutual_ok?: boolean;
  } | null;
};

const AdminSocialQueue: React.FC = () => {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState({ cap: 10, queued: 0, remaining: 10 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{
        rows: QueueRow[];
        ig_dm_cap?: number;
        ig_dm_queued_today?: number;
        ig_dm_remaining?: number;
      }>("list_social_queue", { status: "pending", limit: 50 });
      setRows(data.rows ?? []);
      setQuota({
        cap: data.ig_dm_cap ?? 10,
        queued: data.ig_dm_queued_today ?? 0,
        remaining: data.ig_dm_remaining ?? 10,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Copy failed");
    }
  };

  const markSent = async (id: string) => {
    setBusyId(id);
    try {
      await callHubFn("mark_social_queue_sent", { queue_id: id, performed_by: "admin:ig-queue" });
      toast.success("Marked sent — counts toward daily cap");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/send" className="text-xs text-muted-foreground hover:underline">← Send center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Instagram DM queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Mutual-follow curators only. Each row has an <strong>operator brief</strong> (identity + checklist) and a
          separate <strong>message to paste</strong> — never paste the brief into IG.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          Today: <strong>{quota.queued}</strong> queued · <strong>{quota.remaining}</strong> slots left
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchRows}>Refresh</Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/admin/ig-roster">Roster → verify mutual</Link>
          </Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/admin/playlists">Find placements → Queue batch</Link>
          </Button>
        </div>
      </Card>

      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <Card className="p-4 text-sm text-muted-foreground">
            No pending DMs. Sync roster → mark mutual → Playlists → <em>Queue 10 IG DMs</em>.
          </Card>
        ) : (
          rows.map((r) => {
            const handle = r.ig_handle ?? r.target_url.replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/\/$/, "");
            const expanded = expandedId === r.id;
            return (
              <Card key={r.id} className="p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {r.dm_ref && <span className="text-xs text-muted-foreground mr-2">{r.dm_ref}</span>}
                      <a href={r.target_url} target="_blank" rel="noreferrer" className="underline">
                        @{handle}
                      </a>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {r.result?.engagement_type ?? "pitch"}
                      {r.result?.mutual_ok === false && " · mutual not verified"}
                      {r.result?.featuring?.[0] && ` · spun: ${r.result.featuring[0]}`}
                      {r.result?.pitch_track && ` · pitch: ${r.result.pitch_track}`}
                    </div>
                    <div className="text-xs text-muted-foreground">{r.playlist_id ?? "—"}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {r.draft_text && (
                      <Button size="sm" variant="default" onClick={() => copyText(r.draft_text!, "Copied DM message only")}>
                        Copy message
                      </Button>
                    )}
                    {r.operator_brief && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => copyText(r.operator_brief!, "Copied operator brief")}
                      >
                        Copy brief
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setExpandedId(expanded ? null : r.id)}>
                      {expanded ? "Hide" : "Details"}
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <a href={r.target_url} target="_blank" rel="noreferrer">Open IG</a>
                    </Button>
                    <Button size="sm" disabled={busyId === r.id} onClick={() => markSent(r.id)}>
                      Mark sent
                    </Button>
                  </div>
                </div>
                {expanded && (
                  <div className="grid md:grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="font-medium mb-1 text-muted-foreground">Operator brief</p>
                      <pre className="whitespace-pre-wrap bg-muted/40 rounded p-3 max-h-64 overflow-auto">
                        {r.operator_brief ?? "—"}
                      </pre>
                    </div>
                    <div>
                      <p className="font-medium mb-1 text-muted-foreground">Message to send</p>
                      <pre className="whitespace-pre-wrap bg-muted/40 rounded p-3 max-h-64 overflow-auto border border-primary/20">
                        {r.draft_text ?? "—"}
                      </pre>
                    </div>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
};

export default AdminSocialQueue;
