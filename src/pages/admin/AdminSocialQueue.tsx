import React, { useCallback, useEffect, useState } from "react";
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
};

const AdminSocialQueue: React.FC = () => {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: QueueRow[] }>("list_social_queue", {
        status: "pending",
        limit: 50,
      });
      setRows(data.rows ?? []);
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
      toast.success("Copied to clipboard — paste in IG DM");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">IG DM queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Staged pitches for manual send in Instagram. Email pitches use{" "}
          <a href="/admin/outreach" className="underline">Outreach</a>.
        </p>
      </div>

      <Card className="p-4 border-border/80 bg-muted/20">
        <p className="text-sm">
          Open the profile → paste the draft → send from Fendi&apos;s account. Sending is not automated.
        </p>
      </Card>

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={fetchRows}>
          Refresh
        </Button>
      </div>

      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2">Target</th>
              <th className="text-left p-2">Playlist</th>
              <th className="text-left p-2">Draft</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="p-4 text-muted-foreground">No pending IG DMs. Enrich playlists with IG handles first.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="p-2">
                    <a href={r.target_url} target="_blank" rel="noreferrer" className="underline">
                      {r.target_url.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, "")}
                    </a>
                    <div className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
                  </td>
                  <td className="p-2 text-xs">{r.playlist_id ?? "—"}</td>
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
