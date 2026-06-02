import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type QueueRow = {
  id: string;
  ig_handle: string;
  stage: string;
  template_slug: string;
  draft_text: string;
  operator_brief: string | null;
  dm_ref: string | null;
  status: string;
  personalization_method: string | null;
  instagram_fan_roster?: { display_name: string | null; ig_user_id: string | null; dm_stage: string } | null;
};

type IgStatus = {
  ok?: boolean;
  status?: string;
  token_valid?: boolean;
  token_expires_at?: string;
  message?: string;
};

const AdminFanIgQueue: React.FC = () => {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState({ cap: 10, queued: 0, remaining: 10 });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [igStatus, setIgStatus] = useState<IgStatus | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [importText, setImportText] = useState("");

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const [queue, status] = await Promise.all([
        callHubFn<{
          rows: QueueRow[];
          fan_dm_cap?: number;
          fan_dm_queued_today?: number;
          fan_dm_remaining?: number;
        }>("list_fan_dm_queue", { status: "pending", limit: 50 }),
        callHubFn<IgStatus>("get_instagram_messaging_status", {}),
      ]);
      setRows(queue.rows ?? []);
      setQuota({
        cap: queue.fan_dm_cap ?? 10,
        queued: queue.fan_dm_queued_today ?? 0,
        remaining: queue.fan_dm_remaining ?? 10,
      });
      setIgStatus(status);
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

  const openAndCopy = async (handle: string, message: string) => {
    const url = `https://ig.me/m/${encodeURIComponent(handle.replace(/^@/, ""))}`;
    await copyText(message, "Copied — opening Instagram DM");
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const queueBatch = async () => {
    setBusyId("batch");
    try {
      const res = await callHubFn<{ queued: number; handles: string[] }>("queue_fan_dm_batch", { limit: 10 });
      toast.success(`Queued ${res.queued} fan DM(s) with today's templates`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const runImport = async () => {
    const lines = importText.split("\n").map((l) => l.trim()).filter(Boolean);
    const entries = lines.map((line) => {
      const parts = line.split(/[\t,|]/).map((p) => p.trim());
      const handle = (parts[0] ?? "").replace(/^@/, "");
      return {
        ig_handle: handle,
        display_name: parts[1] || undefined,
        follows_me: parts[2] !== "0" && parts[2]?.toLowerCase() !== "no",
        i_follow: parts[3] === "1" || parts[3]?.toLowerCase() === "yes",
        notes: parts[4],
      };
    }).filter((e) => e.ig_handle);
    if (!entries.length) {
      toast.error("Paste handles: one per line — handle, name, follows_me, i_follow");
      return;
    }
    setBusyId("import");
    try {
      const res = await callHubFn<{ imported: number }>("import_fan_roster", { entries });
      toast.success(`Imported ${res.imported} fan(s)`);
      setImportText("");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const saveDraft = async (id: string) => {
    const text = edits[id];
    if (!text?.trim()) return;
    setBusyId(id);
    try {
      await callHubFn("update_fan_dm_draft", { queue_id: id, draft_text: text });
      toast.success("Draft saved");
      await fetchRows();
      setEdits((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const markSent = async (id: string) => {
    setBusyId(id);
    try {
      const res = await callHubFn<{ next_stage?: string }>("mark_fan_dm_sent", {
        queue_id: id,
        performed_by: "admin:fan-ig-queue",
      });
      toast.success(`Marked sent → next stage: ${res.next_stage ?? "—"}`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const sendViaApi = async (row: QueueRow) => {
    const text = edits[row.id] ?? row.draft_text;
    setBusyId(`api-${row.id}`);
    try {
      await callHubFn("send_fan_dm_via_api", {
        queue_id: row.id,
        draft_text: text,
        mark_sent: true,
      });
      toast.success("Sent via Instagram API");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const apiReady = igStatus?.status === "active" && igStatus?.token_valid !== false;

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/send" className="text-xs text-muted-foreground hover:underline">← Send center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Fan Instagram DMs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Followers who follow you — engagement first, Runway Music in stage 2, soft email invite in stage 3.
          Templates rotate daily (same generic prompt for everyone that day); each message is personalized per fan.
        </p>
      </div>

      <Card className="p-4 space-y-2">
        <div className="text-sm font-medium">Instagram API token</div>
        {igStatus?.status === "active" ? (
          <p className="text-sm text-green-600 dark:text-green-400">
            Connected · expires {String(igStatus.token_expires_at ?? "—")}
          </p>
        ) : (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {igStatus?.message ?? "Token missing or expired"} — use <strong>Open &amp; copy</strong> until you refresh{" "}
            <code className="text-xs">INSTAGRAM_MESSAGING_API_TOKEN</code> in Lovable Cloud.
          </p>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium">Import fans (paste)</div>
        <p className="text-xs text-muted-foreground">
          One per line: <code>handle, display name, follows_me (1/0), i_follow (1/0), notes</code>
        </p>
        <Textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="@fanhandle, Alex, 1, 1"
          rows={4}
        />
        <Button size="sm" disabled={busyId === "import"} onClick={runImport}>
          Import roster
        </Button>
      </Card>

      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          Today: <strong>{quota.queued}</strong> / {quota.cap} · <strong>{quota.remaining}</strong> slots left
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={fetchRows}>Refresh</Button>
          <Button size="sm" disabled={busyId === "batch" || quota.remaining <= 0} onClick={queueBatch}>
            Queue today&apos;s batch (10 max)
          </Button>
        </div>
      </Card>

      <div className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <Card className="p-4 text-sm text-muted-foreground">
            No pending fan DMs. Import followers above → <em>Queue today&apos;s batch</em>.
          </Card>
        ) : (
          rows.map((r) => {
            const handle = r.ig_handle.replace(/^@/, "");
            const draft = edits[r.id] ?? r.draft_text;
            return (
              <Card key={r.id} className="p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">
                      {r.dm_ref && <span className="text-xs text-muted-foreground mr-2">{r.dm_ref}</span>}
                      @{handle}
                      {r.instagram_fan_roster?.display_name && (
                        <span className="text-muted-foreground font-normal ml-2">
                          ({r.instagram_fan_roster.display_name})
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Stage: {r.stage} · template: {r.template_slug}
                      {r.personalization_method && ` · ${r.personalization_method}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="default" onClick={() => openAndCopy(handle, draft)}>
                      Open &amp; copy
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => copyText(draft, "Copied message")}>
                      Copy only
                    </Button>
                    {apiReady && r.instagram_fan_roster?.ig_user_id && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === `api-${r.id}`}
                        onClick={() => sendViaApi(r)}
                      >
                        Send via API
                      </Button>
                    )}
                    <Button size="sm" disabled={busyId === r.id} onClick={() => markSent(r.id)}>
                      Mark sent
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Message to send (edit before copy)</p>
                  <Textarea
                    value={draft}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    rows={5}
                    className="text-sm"
                  />
                  {edits[r.id] != null && edits[r.id] !== r.draft_text && (
                    <Button size="sm" className="mt-2" variant="outline" onClick={() => saveDraft(r.id)}>
                      Save edit
                    </Button>
                  )}
                </div>
                {r.operator_brief && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Operator brief (do not paste)</summary>
                    <pre className="whitespace-pre-wrap bg-muted/40 rounded p-3 mt-2 max-h-48 overflow-auto">
                      {r.operator_brief}
                    </pre>
                  </details>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
};

export default AdminFanIgQueue;
