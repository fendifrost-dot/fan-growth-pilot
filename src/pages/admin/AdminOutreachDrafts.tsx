import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type DraftRow = {
  id: string;
  playlist_id: string;
  track_name: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  status: string;
  generated_at: string;
  metadata?: {
    operator_brief?: string | null;
    dm_ref?: string | null;
    placement_source?: string | null;
  } | null;
};

const AdminOutreachDrafts: React.FC = () => {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DraftRow | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editRecipient, setEditRecipient] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: DraftRow[] }>("list_drafts", {
        statuses: ["pending", "approved"],
      });
      setDrafts(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  useEffect(() => {
    if (!selected) return;
    setEditSubject(selected.subject ?? "");
    setEditBody(selected.body);
    setEditRecipient(selected.recipient ?? "");
  }, [selected]);

  const saveEdits = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await callHubFn("update_draft", {
        draft_id: selected.id,
        subject: editSubject,
        body: editBody,
        recipient: editRecipient,
      });
      toast.success("Draft saved");
      await fetchDrafts();
      setSelected((s) => s ? { ...s, subject: editSubject, body: editBody, recipient: editRecipient } : null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const approve = async (sendImmediately: boolean) => {
    if (!selected) return;
    setSaving(true);
    try {
      if (editBody !== selected.body || editSubject !== (selected.subject ?? "")) {
        await callHubFn("update_draft", {
          draft_id: selected.id,
          subject: editSubject,
          body: editBody,
          recipient: editRecipient,
        });
      }
      const res = await callHubFn<{ status: string; sent?: boolean; needs_manual_dm?: boolean }>(
        "approve_draft",
        {
          draft_id: selected.id,
          approved_by: "admin:ui",
          send_immediately: sendImmediately,
        },
      );
      if (res.needs_manual_dm) {
        toast.message("Approved — copy body and DM manually on Instagram");
      } else if (res.sent) {
        toast.success("Approved and sent");
      } else {
        toast.success("Approved (not sent)");
      }
      await fetchDrafts();
      setSelected(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const reject = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await callHubFn("approve_draft", {
        draft_id: selected.id,
        approved_by: "admin:ui",
        reject: true,
      });
      toast.success("Draft rejected");
      await fetchDrafts();
      setSelected(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/playlists" className="text-xs text-muted-foreground hover:underline">← Find playlists</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Send curator pitches</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Step 4: review drafts from playlist targets, then <strong>Approve &amp; send</strong> (one email per curator,
          logged to <Link to="/admin/pitch-log" className="underline">pitch log</Link>).
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-0 overflow-hidden">
          <div className="p-3 border-b flex justify-between items-center">
            <span className="text-sm font-medium">Pending / approved</span>
            <Button size="sm" variant="outline" onClick={fetchDrafts}>Refresh</Button>
          </div>
          <div className="max-h-[480px] overflow-auto">
            {loading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : drafts.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No drafts yet.</p>
            ) : (
              <ul>
                {drafts.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      className={`w-full text-left p-3 border-b hover:bg-muted/40 ${selected?.id === d.id ? "bg-muted/60" : ""}`}
                      onClick={() => setSelected(d)}
                    >
                      <div className="font-medium text-sm">{d.track_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {d.channel} · {d.status} · {new Date(d.generated_at).toLocaleString()}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          {!selected ? (
            <p className="text-sm text-muted-foreground">Select a draft to edit and approve.</p>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {selected.playlist_id} · {selected.channel}
                {selected.metadata?.dm_ref && ` · ${selected.metadata.dm_ref}`}
              </div>
              {selected.metadata?.operator_brief && (
                <div>
                  <label className="text-xs text-muted-foreground">Operator brief (placement context — not sent)</label>
                  <pre className="text-xs whitespace-pre-wrap bg-muted/40 rounded p-3 max-h-40 overflow-auto">
                    {selected.metadata.operator_brief}
                  </pre>
                </div>
              )}
              <div>
                <label className="text-xs text-muted-foreground">Recipient</label>
                <Input value={editRecipient} onChange={(e) => setEditRecipient(e.target.value)} />
              </div>
              {selected.channel === "email" && (
                <div>
                  <label className="text-xs text-muted-foreground">Subject</label>
                  <Input value={editSubject} onChange={(e) => setEditSubject(e.target.value)} />
                </div>
              )}
              <div>
                <label className="text-xs text-muted-foreground">Body</label>
                <Textarea className="min-h-[200px] font-mono text-sm" value={editBody} onChange={(e) => setEditBody(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={saving} onClick={saveEdits}>Save edits</Button>
                <Button type="button" variant="secondary" disabled={saving} onClick={() => approve(false)}>Approve only</Button>
                <Button type="button" disabled={saving} onClick={() => approve(true)}>Approve &amp; send</Button>
                <Button type="button" variant="ghost" disabled={saving} onClick={reject}>Reject</Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

export default AdminOutreachDrafts;
