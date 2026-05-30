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
  playlist_id: string | null;
  status: string;
  created_at: string;
  result?: {
    engagement_type?: string;
    featuring?: string[];
    pitch_track?: string;
  } | null;
};

const AdminSocialQueue: React.FC = () => {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState({ cap: 10, queued: 0, remaining: 10 });
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied — paste in IG DM");
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
          Up to <strong>{quota.cap}</strong> personalized DMs per day (UTC). Each message is unique — thank-you for
          existing placements + pitch for your new track. Send manually from Fendi&apos;s IG account.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          Today: <strong>{quota.queued}</strong> queued · <strong>{quota.remaining}</strong> slots left
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchRows}>Refresh</Button>
          <Button variant="secondary" size="sm" asChild>
            <Link to="/admin/playlists">Find placements → Queue batch</Link>
          </Button>
        </div>
      </Card>

      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2">Curator</th>
              <th className="text-left p-2">Type</th>
              <th className="text-left p-2">Draft (unique)</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-4 text-muted-foreground">
                  No pending DMs. Use Playlists → <em>Find playlists with my music</em> → Enrich →{" "}
                  <em>Queue 10 IG DMs</em>.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="p-2">
                    <a href={r.target_url} target="_blank" rel="noreferrer" className="underline">
                      {r.target_url.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, "")}
                    </a>
                    <div className="text-xs text-muted-foreground">{r.playlist_id ?? "—"}</div>
                  </td>
                  <td className="p-2 text-xs">
                    {r.result?.engagement_type ?? "pitch"}
                    {r.result?.featuring?.[0] && (
                      <div className="text-muted-foreground">Spun: {r.result.featuring[0]}</div>
                    )}
                  </td>
                  <td className="p-2 max-w-md whitespace-pre-wrap text-xs">{r.draft_text ?? "—"}</td>
                  <td className="p-2 space-y-1">
                    {r.draft_text && (
                      <Button size="sm" variant="secondary" onClick={() => copyText(r.draft_text!)}>
                        Copy DM
                      </Button>
                    )}
                    <Button size="sm" variant="outline" asChild>
                      <a href={r.target_url} target="_blank" rel="noreferrer">Open IG</a>
                    </Button>
                    <Button
                      size="sm"
                      disabled={busyId === r.id}
                      onClick={() => markSent(r.id)}
                    >
                      Mark sent
                    </Button>
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

export default AdminSocialQueue;
