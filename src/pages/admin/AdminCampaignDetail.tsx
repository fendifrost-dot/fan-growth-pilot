import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

interface CampaignSendResponse {
  html?: string;
  text?: string;
  subject?: string;
  from?: string;
  result?: { ok: boolean; error?: string };
  would_send?: number;
  sent?: number;
  failed?: number;
  remaining_subscribed?: number;
}

interface Campaign {
  id: string;
  name: string;
  slug: string;
  status: string;
  from_email: string;
  from_name: string;
  reply_to: string | null;
  template_id: string;
  total_sent: number;
  total_failed: number;
}

interface SendLog {
  id: string;
  recipient_email: string;
  status: string;
  resend_message_id: string | null;
  error_message: string | null;
  test_send: boolean;
  batch_label: string | null;
  sent_at: string;
}

const AdminCampaignDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [previewText, setPreviewText] = useState<string>("");
  const [previewSubject, setPreviewSubject] = useState<string>("");
  const [previewFrom, setPreviewFrom] = useState<string>("");
  const [testEmail, setTestEmail] = useState("fendifrost@gmail.com");
  const [testFirstName, setTestFirstName] = useState("Fendi");
  const [batchSize, setBatchSize] = useState(100);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<SendLog[]>([]);
  const [subscribedCount, setSubscribedCount] = useState<number>(0);
  const [audienceLeft, setAudienceLeft] = useState<number | null>(null);

  const reload = async () => {
    if (!slug) return;
    const { data: c } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("slug", slug)
      .maybeSingle();
    setCampaign((c as Campaign) ?? null);

    if (c?.id) {
      const { data: l } = await supabase
        .from("email_sends")
        .select("*")
        .eq("campaign_id", c.id)
        .order("sent_at", { ascending: false })
        .limit(100);
      setLogs((l ?? []) as SendLog[]);

      const { count: subs } = await supabase.from("email_contacts").select("*", { count: "exact", head: true }).eq("subscribed", true);
      setSubscribedCount(subs ?? 0);

      // remaining = subscribed - distinct contact_ids in successful real sends
      const { data: sent } = await supabase
        .from("email_sends")
        .select("contact_id")
        .eq("campaign_id", c.id)
        .eq("status", "sent")
        .eq("test_send", false);
      const distinct = new Set((sent ?? []).map((r: any) => r.contact_id).filter(Boolean));
      setAudienceLeft(Math.max(0, (subs ?? 0) - distinct.size));
    }
  };

  useEffect(() => { reload(); }, [slug]);

  const loadPreview = async () => {
    if (!campaign) return;
    try {
      setBusy("preview");
      const data = await callHubFn<CampaignSendResponse>("send_campaign", {
        mode: "preview",
        campaign_id: campaign.id,
        to_first_name: testFirstName || "Friend",
      });
      setPreviewHtml(data.html ?? "");
      setPreviewText(data.text ?? "");
      setPreviewSubject(data.subject ?? "");
      setPreviewFrom(data.from ?? "");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  const sendTest = async () => {
    if (!campaign) return;
    if (!testEmail.includes("@")) { toast.error("Enter a valid email"); return; }
    try {
      setBusy("test");
      const data = await callHubFn<CampaignSendResponse>("send_campaign", {
        mode: "test",
        campaign_id: campaign.id,
        to_email: testEmail,
        to_first_name: testFirstName || undefined,
      });
      if (data.result?.ok) toast.success(`Test sent to ${testEmail}`);
      else toast.error(`Test failed: ${data.result?.error || "unknown"}`);
      reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  const sendBatch = async (dryRun: boolean) => {
    if (!campaign) return;
    const label = `batch-${batchSize}-${new Date().toISOString().slice(0, 16).replace(":", "")}`;
    try {
      setBusy(dryRun ? "dry" : "batch");
      const data = await callHubFn<CampaignSendResponse>("send_campaign", {
        mode: "batch",
        campaign_id: campaign.id,
        batch_size: batchSize,
        batch_label: label,
        dry_run: dryRun,
      });
      if (dryRun) {
        toast.info(`Dry run: would send to ${data.would_send ?? 0} contacts`);
      } else {
        toast.success(`Batch ${label}: ${data.sent ?? 0} sent, ${data.failed ?? 0} failed. ${data.remaining_subscribed ?? 0} left.`);
      }
      reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };

  if (!campaign) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/admin/campaigns" className="text-xs text-muted-foreground hover:underline">← All campaigns</Link>
          <h1 className="text-2xl font-medium tracking-tight mt-1">{campaign.name}</h1>
          <div className="text-sm text-muted-foreground">{campaign.slug} · status: <span className="font-mono">{campaign.status}</span></div>
        </div>
        <div className="text-right text-sm">
          <div><span className="text-muted-foreground">Sent:</span> {campaign.total_sent}</div>
          <div><span className="text-muted-foreground">Failed:</span> {campaign.total_failed}</div>
          <div><span className="text-muted-foreground">Audience left:</span> {audienceLeft ?? "…"} / {subscribedCount}</div>
        </div>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="text-lg font-medium">Test send</h2>
        <p className="text-xs text-muted-foreground">Sends a single email with the full rendered template. Logged as test_send=true (won't count against audience).</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="testEmail">Recipient email</Label>
            <Input id="testEmail" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="testFirstName">First name (for {"{{first_name}}"})</Label>
            <Input id="testFirstName" value={testFirstName} onChange={(e) => setTestFirstName(e.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={sendTest} disabled={busy !== null}>{busy === "test" ? "Sending…" : "Send test"}</Button>
            <Button variant="outline" onClick={loadPreview} disabled={busy !== null}>{busy === "preview" ? "Loading…" : "Preview"}</Button>
          </div>
        </div>
      </Card>

      {previewHtml && (
        <Card className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Subject</div>
              <div className="font-medium">{previewSubject}</div>
            </div>
            <div className="text-xs text-muted-foreground">From: {previewFrom}</div>
          </div>
          <div className="rounded border bg-white">
            <iframe srcDoc={previewHtml} title="email preview" className="w-full h-[600px]" />
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Plain-text fallback</summary>
            <pre className="mt-2 p-3 bg-muted rounded whitespace-pre-wrap">{previewText}</pre>
          </details>
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <h2 className="text-lg font-medium">Batch send</h2>
        <p className="text-xs text-muted-foreground">
          Phased rollout. Recommended for first send: <strong>100 → 200 → remaining</strong>.
          Only subscribed contacts who haven't already received this campaign successfully will be sent. ~8 emails/sec, safe for Resend free tier.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="batchSize">Batch size</Label>
            <Input id="batchSize" type="number" min={1} max={500} value={batchSize} onChange={(e) => setBatchSize(Math.max(1, Math.min(500, Number(e.target.value))))} />
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <Button variant="outline" onClick={() => sendBatch(true)}  disabled={busy !== null}>{busy === "dry"   ? "Checking…" : `Dry run (${batchSize})`}</Button>
            <Button onClick={() => sendBatch(false)} disabled={busy !== null}>{busy === "batch" ? "Sending…"   : `SEND ${batchSize} now`}</Button>
            <Button variant="ghost" onClick={() => setBatchSize(100)}>100</Button>
            <Button variant="ghost" onClick={() => setBatchSize(200)}>200</Button>
            <Button variant="ghost" onClick={() => setBatchSize(audienceLeft ?? 100)} title="Send remaining">All left</Button>
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Send log</h2>
          <Button variant="ghost" size="sm" onClick={reload}>Refresh</Button>
        </div>
        <div className="rounded border overflow-auto max-h-[480px]">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left p-2">Sent at</th>
                <th className="text-left p-2">Recipient</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Batch</th>
                <th className="text-left p-2">Resend ID</th>
                <th className="text-left p-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && <tr><td colSpan={6} className="p-3 text-muted-foreground">No sends yet</td></tr>}
              {logs.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="p-2 font-mono">{new Date(l.sent_at).toLocaleString()}</td>
                  <td className="p-2 font-mono">{l.recipient_email}</td>
                  <td className="p-2">
                    <span className={l.status === "sent" ? "text-emerald-700" : l.status === "failed" ? "text-red-700" : "text-muted-foreground"}>
                      {l.status}{l.test_send ? " (test)" : ""}
                    </span>
                  </td>
                  <td className="p-2 font-mono">{l.batch_label ?? "—"}</td>
                  <td className="p-2 font-mono text-muted-foreground">{l.resend_message_id ?? "—"}</td>
                  <td className="p-2 text-red-700">{l.error_message ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export default AdminCampaignDetail;
