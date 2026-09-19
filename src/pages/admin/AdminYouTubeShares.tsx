import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";
import {
  WINDOW_LABEL,
  YT_FUNNEL_STAGES,
  YT_METRIC_WINDOWS,
  YT_QUALIFICATION,
  YT_SCORE_FIELDS,
  YT_SHARE_TYPES,
  titleCase,
  type YtCampaign,
  type YtEvent,
  type YtMeasurementWindow,
  type YtMetricWindow,
  type YtMoment,
  type YtTarget,
} from "@/lib/youtubeShares";

const AdminYouTubeShares: React.FC = () => {
  const [campaigns, setCampaigns] = useState<YtCampaign[]>([]);
  const [activeCampaignId, setActiveCampaignId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const loadCampaigns = useCallback(async () => {
    try {
      const res = await callHubFn<{ rows: YtCampaign[] }>("list_youtube_share_campaigns", {});
      const rows = res.rows ?? [];
      setCampaigns(rows);
      setActiveCampaignId((cur) => cur || rows.find((r) => r.status === "active")?.id || rows[0]?.id || "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  const activeCampaign = campaigns.find((c) => c.id === activeCampaignId) ?? null;

  return (
    <div className="space-y-6" data-testid="youtube-shares">
      <div>
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">YouTube Shares</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          Native share seeding — Community Posts, timestamp shares, creator shares. The offer is
          <em> "would you share this with your YouTube audience?"</em>, not a playlist add. A share counts only
          when <strong>verified</strong>. Measurement shows <strong>Observed Lift</strong>, never attributed views.
        </p>
      </div>

      <Card className="p-4 flex flex-wrap items-end gap-4">
        <div className="min-w-64">
          <Label className="text-xs text-muted-foreground">Campaign lane</Label>
          <Select value={activeCampaignId} onValueChange={setActiveCampaignId}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Pick a campaign" /></SelectTrigger>
            <SelectContent>
              {campaigns.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.track_label} · {titleCase(c.campaign_type)} · {c.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {activeCampaign && (
          <div className="text-xs text-muted-foreground">
            Video: {activeCampaign.youtube_video_id
              ? <code>{activeCampaign.youtube_video_id}</code>
              : <span className="italic">none assigned</span>}
            {activeCampaign.status !== "active" && (
              <Badge variant="outline" className="ml-2">outreach blocked</Badge>
            )}
          </div>
        )}
        <Button variant="outline" onClick={loadCampaigns} disabled={loading}>Refresh</Button>
      </Card>

      <Tabs defaultValue="campaigns">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="targets">Targets</TabsTrigger>
          <TabsTrigger value="moments">Moments</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="measurement">Measurement</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-4">
          <CampaignsTab campaigns={campaigns} onChange={loadCampaigns} />
        </TabsContent>
        <TabsContent value="targets" className="mt-4">
          <TargetsTab campaign={activeCampaign} />
        </TabsContent>
        <TabsContent value="moments" className="mt-4">
          <MomentsTab campaign={activeCampaign} />
        </TabsContent>
        <TabsContent value="verification" className="mt-4">
          <VerificationTab campaign={activeCampaign} />
        </TabsContent>
        <TabsContent value="measurement" className="mt-4">
          <MeasurementTab campaign={activeCampaign} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
const CampaignsTab: React.FC<{ campaigns: YtCampaign[]; onChange: () => void }> = ({ campaigns, onChange }) => {
  const [saving, setSaving] = useState<string | null>(null);

  const patch = async (c: YtCampaign, fields: Record<string, unknown>) => {
    setSaving(c.id);
    try {
      await callHubFn("upsert_youtube_share_campaign", { id: c.id, ...fields });
      toast.success("Campaign updated");
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-4">
      {campaigns.map((c) => (
        <Card key={c.id} className="p-5 space-y-3" data-testid="yt-campaign-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-medium">{c.track_label}</h3>
              <p className="text-xs text-muted-foreground">
                {titleCase(c.campaign_type)} · video {c.youtube_video_id
                  ? <code>{c.youtube_video_id}</code>
                  : <span className="italic">unassigned</span>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={c.status}
                onValueChange={(v) => patch(c, { status: v })}
                disabled={saving === c.id}
              >
                <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="paused">paused</SelectItem>
                  <SelectItem value="disabled">disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {c.campaign_type === "current_release" && !c.youtube_video_id && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label className="text-xs">Assign YouTube video ID</Label>
                <Input
                  className="mt-1 w-56"
                  placeholder="e.g. dQw4w9WgXcQ"
                  defaultValue=""
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v) patch(c, { youtube_video_id: v });
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground pb-2">Cannot activate until a video is assigned.</p>
            </div>
          )}
          {c.content_guardrails && (
            <div className="text-xs rounded border border-amber-500/30 bg-amber-500/5 p-3">
              <span className="font-medium">Content guardrails:</span> {c.content_guardrails}
            </div>
          )}
          {c.notes && <p className="text-xs text-muted-foreground">{c.notes}</p>}
        </Card>
      ))}
      {campaigns.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">No campaigns yet.</Card>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
const emptyTarget = {
  channel_name: "",
  channel_url: "",
  category: "",
  subscriber_count: "",
  audience_fit_score: "",
  activity_score: "",
  authenticity_score: "",
  share_probability_score: "",
  estimated_impact_score: "",
  notes: "",
};

const TargetsTab: React.FC<{ campaign: YtCampaign | null }> = ({ campaign }) => {
  const [rows, setRows] = useState<YtTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [form, setForm] = useState(emptyTarget);
  const [fStage, setFStage] = useState<string>("all");
  const [fQual, setFQual] = useState<string>("all");
  const [fCategory, setFCategory] = useState<string>("");
  const [minShare, setMinShare] = useState<string>("");

  const load = useCallback(async () => {
    if (!campaign) { setRows([]); return; }
    setLoading(true);
    try {
      const res = await callHubFn<{ rows: YtTarget[] }>("list_youtube_share_targets", {
        campaign_id: campaign.id,
        funnel_stage: fStage === "all" ? undefined : fStage,
        qualification_status: fQual === "all" ? undefined : fQual,
        category: fCategory.trim() || undefined,
        min_share_probability_score: minShare.trim() ? Number(minShare) : undefined,
      });
      setRows(res.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load targets");
    } finally {
      setLoading(false);
    }
  }, [campaign, fStage, fQual, fCategory, minShare]);

  useEffect(() => { load(); }, [load]);

  const addTarget = async () => {
    if (!campaign) return;
    if (!form.channel_name.trim()) { toast.error("Channel name required"); return; }
    setSaving("new");
    try {
      const scores: Record<string, unknown> = {};
      for (const s of YT_SCORE_FIELDS) {
        const v = (form as Record<string, string>)[s.key];
        if (v.trim()) scores[s.key] = Number(v);
      }
      await callHubFn("upsert_youtube_share_target", {
        campaign_id: campaign.id,
        channel_name: form.channel_name.trim(),
        channel_url: form.channel_url.trim() || null,
        category: form.category.trim() || null,
        subscriber_count: form.subscriber_count.trim() ? Number(form.subscriber_count) : null,
        notes: form.notes.trim() || null,
        ...scores,
      });
      toast.success("Target added");
      setForm(emptyTarget);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setSaving(null);
    }
  };

  const patch = async (t: YtTarget, fields: Record<string, unknown>) => {
    setSaving(t.id);
    try {
      await callHubFn("upsert_youtube_share_target", { id: t.id, ...fields });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(null);
    }
  };

  const qualifiedCount = useMemo(() => rows.filter((r) => r.qualification_status === "qualified").length, [rows]);

  if (!campaign) return <Card className="p-6 text-sm text-muted-foreground">Pick a campaign lane first.</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3" data-testid="yt-target-form">
        <h3 className="font-medium">Add target — {campaign.track_label}</h3>
        <p className="text-xs text-muted-foreground">
          Score dimensions are stored separately (0-100). Don't overweight subscriber count.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Channel name *</Label>
            <Input value={form.channel_name} onChange={(e) => setForm({ ...form, channel_name: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Channel URL</Label>
            <Input value={form.channel_url} onChange={(e) => setForm({ ...form, channel_url: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Category</Label>
            <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="reaction, curator, community…" />
          </div>
          <div>
            <Label className="text-xs">Subscribers (weak signal)</Label>
            <Input type="number" value={form.subscriber_count} onChange={(e) => setForm({ ...form, subscriber_count: e.target.value })} />
          </div>
          {YT_SCORE_FIELDS.map((s) => (
            <div key={s.key}>
              <Label className="text-xs">{s.label} (0-100)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={(form as Record<string, string>)[s.key]}
                onChange={(e) => setForm({ ...form, [s.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="md:col-span-3">
            <Label className="text-xs">Notes</Label>
            <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <Button onClick={addTarget} disabled={saving === "new"}>{saving === "new" ? "Saving…" : "Add target"}</Button>
      </Card>

      <Card className="p-4 flex flex-wrap items-end gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Funnel stage</Label>
          <Select value={fStage} onValueChange={setFStage}>
            <SelectTrigger className="mt-1 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {YT_FUNNEL_STAGES.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Qualification</Label>
          <Select value={fQual} onValueChange={setFQual}>
            <SelectTrigger className="mt-1 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {YT_QUALIFICATION.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Input className="mt-1 w-40" value={fCategory} onChange={(e) => setFCategory(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Min share prob.</Label>
          <Input className="mt-1 w-28" type="number" value={minShare} onChange={(e) => setMinShare(e.target.value)} />
        </div>
        <div className="text-xs text-muted-foreground pb-2">
          {rows.length} shown · {qualifiedCount} qualified
        </div>
      </Card>

      <div className="overflow-x-auto border rounded-lg" data-testid="yt-target-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Channel</th>
              <th className="text-left p-3">Category</th>
              <th className="text-left p-3">Scores (fit/act/auth/share/impact)</th>
              <th className="text-left p-3">Subs</th>
              <th className="text-left p-3">Qualification</th>
              <th className="text-left p-3">Stage</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No targets match.</td></tr>
            ) : rows.map((t) => (
              <tr key={t.id} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">
                    {t.channel_url
                      ? <a href={t.channel_url} target="_blank" rel="noreferrer" className="hover:underline">{t.channel_name}</a>
                      : t.channel_name}
                  </div>
                  {t.notes && <div className="text-xs text-muted-foreground max-w-xs truncate">{t.notes}</div>}
                </td>
                <td className="p-3 text-xs">{t.category || "—"}</td>
                <td className="p-3 text-xs whitespace-nowrap">
                  {[t.audience_fit_score, t.activity_score, t.authenticity_score, t.share_probability_score, t.estimated_impact_score]
                    .map((v) => (v ?? "–")).join(" / ")}
                </td>
                <td className="p-3 text-xs">{t.subscriber_count?.toLocaleString() ?? "—"}</td>
                <td className="p-3">
                  <Select value={t.qualification_status} onValueChange={(v) => patch(t, { qualification_status: v })} disabled={saving === t.id}>
                    <SelectTrigger className="w-32 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {YT_QUALIFICATION.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </td>
                <td className="p-3">
                  <Select value={t.funnel_stage} onValueChange={(v) => patch(t, { funnel_stage: v })} disabled={saving === t.id}>
                    <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {YT_FUNNEL_STAGES.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------
const emptyMoment = { timestamp_label: "", timestamp_seconds: "", angle: "", suggested_caption: "", why_audience_cares: "", audience_segment: "" };

const MomentsTab: React.FC<{ campaign: YtCampaign | null }> = ({ campaign }) => {
  const [rows, setRows] = useState<YtMoment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [form, setForm] = useState(emptyMoment);

  const load = useCallback(async () => {
    if (!campaign) { setRows([]); return; }
    setLoading(true);
    try {
      const res = await callHubFn<{ rows: YtMoment[] }>("list_youtube_share_moments", { campaign_id: campaign.id });
      setRows(res.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load moments");
    } finally {
      setLoading(false);
    }
  }, [campaign]);

  useEffect(() => { load(); }, [load]);

  const addMoment = async () => {
    if (!campaign) return;
    setSaving("new");
    try {
      await callHubFn("upsert_youtube_share_moment", {
        campaign_id: campaign.id,
        timestamp_label: form.timestamp_label.trim() || null,
        timestamp_seconds: form.timestamp_seconds.trim() ? Number(form.timestamp_seconds) : null,
        angle: form.angle.trim() || null,
        suggested_caption: form.suggested_caption.trim() || null,
        why_audience_cares: form.why_audience_cares.trim() || null,
        audience_segment: form.audience_segment.trim() || null,
      });
      toast.success("Moment added");
      setForm(emptyMoment);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setSaving(null);
    }
  };

  const removeMoment = async (id: string) => {
    if (!confirm("Delete this moment?")) return;
    setSaving(id);
    try {
      await callHubFn("delete_youtube_share_moment", { id });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(null);
    }
  };

  if (!campaign) return <Card className="p-6 text-sm text-muted-foreground">Pick a campaign lane first.</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3" data-testid="yt-moment-form">
        <h3 className="font-medium">Add moment — {campaign.track_label}</h3>
        <p className="text-xs text-muted-foreground">
          Recommended timestamp + suggested post angle + suggested caption + why the audience cares.
          Captions are suggestions.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Timestamp label</Label>
            <Input value={form.timestamp_label} onChange={(e) => setForm({ ...form, timestamp_label: e.target.value })} placeholder="1:23" />
          </div>
          <div>
            <Label className="text-xs">Timestamp (seconds)</Label>
            <Input type="number" value={form.timestamp_seconds} onChange={(e) => setForm({ ...form, timestamp_seconds: e.target.value })} placeholder="83" />
          </div>
          <div>
            <Label className="text-xs">Audience segment</Label>
            <Input value={form.audience_segment} onChange={(e) => setForm({ ...form, audience_segment: e.target.value })} />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">Suggested post angle</Label>
            <Textarea rows={2} value={form.angle} onChange={(e) => setForm({ ...form, angle: e.target.value })} />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">Suggested caption (suggestion)</Label>
            <Textarea rows={2} value={form.suggested_caption} onChange={(e) => setForm({ ...form, suggested_caption: e.target.value })} />
          </div>
          <div className="md:col-span-3">
            <Label className="text-xs">Why their audience cares</Label>
            <Textarea rows={2} value={form.why_audience_cares} onChange={(e) => setForm({ ...form, why_audience_cares: e.target.value })} />
          </div>
        </div>
        <Button onClick={addMoment} disabled={saving === "new"}>{saving === "new" ? "Saving…" : "Add moment"}</Button>
      </Card>

      <div className="space-y-3" data-testid="yt-moment-list">
        {loading ? (
          <Card className="p-4 text-sm text-muted-foreground">Loading…</Card>
        ) : rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">No moments yet.</Card>
        ) : rows.map((m) => (
          <Card key={m.id} className="p-4 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                {m.timestamp_label && <Badge variant="secondary">{m.timestamp_label}</Badge>}
                {m.audience_segment && <span className="text-xs text-muted-foreground">{m.audience_segment}</span>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => removeMoment(m.id)} disabled={saving === m.id}>Delete</Button>
            </div>
            {m.angle && <p className="text-sm"><span className="text-muted-foreground text-xs">Angle: </span>{m.angle}</p>}
            {m.suggested_caption && <p className="text-sm text-muted-foreground italic">"{m.suggested_caption}"</p>}
            {m.why_audience_cares && <p className="text-xs text-muted-foreground"><span className="font-medium">Why: </span>{m.why_audience_cares}</p>}
          </Card>
        ))}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
const VerificationTab: React.FC<{ campaign: YtCampaign | null }> = ({ campaign }) => {
  const [events, setEvents] = useState<YtEvent[]>([]);
  const [targets, setTargets] = useState<YtTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [form, setForm] = useState({ target_id: "", share_type: "community_post", share_url: "", observed_at: "", notes: "" });

  const load = useCallback(async () => {
    if (!campaign) { setEvents([]); setTargets([]); return; }
    setLoading(true);
    try {
      const [ev, tg] = await Promise.all([
        callHubFn<{ rows: YtEvent[] }>("list_youtube_share_events", {
          campaign_id: campaign.id,
          verification_status: filter === "all" ? undefined : filter,
        }),
        callHubFn<{ rows: YtTarget[] }>("list_youtube_share_targets", { campaign_id: campaign.id, limit: 500 }),
      ]);
      setEvents(ev.rows ?? []);
      setTargets(tg.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load verification queue");
    } finally {
      setLoading(false);
    }
  }, [campaign, filter]);

  useEffect(() => { load(); }, [load]);

  const targetName = (id: string) => targets.find((t) => t.id === id)?.channel_name ?? id.slice(0, 8);

  const recordShare = async () => {
    if (!form.target_id) { toast.error("Pick a target"); return; }
    setSaving("new");
    try {
      await callHubFn("record_youtube_share_event", {
        target_id: form.target_id,
        share_type: form.share_type,
        share_url: form.share_url.trim() || null,
        observed_at: form.observed_at ? new Date(form.observed_at).toISOString() : null,
        notes: form.notes.trim() || null,
      });
      toast.success("Share claim recorded (pending verification)");
      setForm({ target_id: "", share_type: "community_post", share_url: "", observed_at: "", notes: "" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Record failed");
    } finally {
      setSaving(null);
    }
  };

  const verify = async (ev: YtEvent) => {
    setSaving(ev.id);
    try {
      await callHubFn("verify_youtube_share_event", { event_id: ev.id });
      toast.success("Share verified — now counts");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setSaving(null);
    }
  };

  const reject = async (ev: YtEvent) => {
    const reason = window.prompt("Rejection reason");
    if (reason === null) return;
    setSaving(ev.id);
    try {
      await callHubFn("reject_youtube_share_event", { event_id: ev.id, rejected_reason: reason.trim() || null });
      toast.success("Share rejected");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setSaving(null);
    }
  };

  if (!campaign) return <Card className="p-6 text-sm text-muted-foreground">Pick a campaign lane first.</Card>;

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3" data-testid="yt-share-record-form">
        <h3 className="font-medium">Record a claimed share</h3>
        <p className="text-xs text-muted-foreground">A share is only counted once verified below.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Target *</Label>
            <Select value={form.target_id} onValueChange={(v) => setForm({ ...form, target_id: v })}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Pick target" /></SelectTrigger>
              <SelectContent>
                {targets.map((t) => <SelectItem key={t.id} value={t.id}>{t.channel_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Share type</Label>
            <Select value={form.share_type} onValueChange={(v) => setForm({ ...form, share_type: v })}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YT_SHARE_TYPES.map((s) => <SelectItem key={s} value={s}>{titleCase(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Proof URL</Label>
            <Input value={form.share_url} onChange={(e) => setForm({ ...form, share_url: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Observed at</Label>
            <Input type="datetime-local" value={form.observed_at} onChange={(e) => setForm({ ...form, observed_at: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <Label className="text-xs">Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <Button onClick={recordShare} disabled={saving === "new"}>{saving === "new" ? "Saving…" : "Record claim"}</Button>
      </Card>

      <Card className="p-4 flex items-end gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="mt-1 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-xs text-muted-foreground pb-2">
          {events.filter((e) => e.verification_status === "verified").length} verified
        </div>
      </Card>

      <div className="overflow-x-auto border rounded-lg" data-testid="yt-verification-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Target</th>
              <th className="text-left p-3">Type</th>
              <th className="text-left p-3">Proof</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : events.length === 0 ? (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No share events.</td></tr>
            ) : events.map((ev) => (
              <tr key={ev.id} className="border-t align-top">
                <td className="p-3 font-medium">{targetName(ev.target_id)}</td>
                <td className="p-3 text-xs">{titleCase(ev.share_type)}</td>
                <td className="p-3 text-xs">
                  {ev.share_url
                    ? <a href={ev.share_url} target="_blank" rel="noreferrer" className="hover:underline">link</a>
                    : "—"}
                </td>
                <td className="p-3">
                  <Badge variant={ev.verification_status === "verified" ? "default" : ev.verification_status === "rejected" ? "destructive" : "secondary"}>
                    {ev.verification_status}
                  </Badge>
                  {ev.rejected_reason && <div className="text-xs text-muted-foreground mt-1">{ev.rejected_reason}</div>}
                </td>
                <td className="p-3">
                  {ev.verification_status === "pending" ? (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => verify(ev)} disabled={saving === ev.id}>Verify</Button>
                      <Button size="sm" variant="ghost" onClick={() => reject(ev)} disabled={saving === ev.id}>Reject</Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{ev.verified_by_label || "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
const MeasurementTab: React.FC<{ campaign: YtCampaign | null }> = ({ campaign }) => {
  const [windows, setWindows] = useState<YtMeasurementWindow[]>([]);
  const [baseline, setBaseline] = useState<YtMeasurementWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ window_label: "baseline" as YtMetricWindow, impressions: "", views: "", likes: "", comments: "", notes: "" });

  const load = useCallback(async () => {
    if (!campaign) { setWindows([]); setBaseline(null); return; }
    setLoading(true);
    try {
      const res = await callHubFn<{ baseline: YtMeasurementWindow; windows: YtMeasurementWindow[] }>(
        "get_youtube_share_measurement", { campaign_id: campaign.id });
      setBaseline(res.baseline ?? null);
      setWindows(res.windows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load measurement");
    } finally {
      setLoading(false);
    }
  }, [campaign]);

  useEffect(() => { load(); }, [load]);

  const record = async () => {
    if (!campaign) return;
    setSaving(true);
    try {
      await callHubFn("record_youtube_share_metric", {
        campaign_id: campaign.id,
        window_label: form.window_label,
        impressions: form.impressions.trim() ? Number(form.impressions) : null,
        views: form.views.trim() ? Number(form.views) : null,
        likes: form.likes.trim() ? Number(form.likes) : null,
        comments: form.comments.trim() ? Number(form.comments) : null,
        notes: form.notes.trim() || null,
      });
      toast.success("Capture recorded");
      setForm({ ...form, impressions: "", views: "", likes: "", comments: "", notes: "" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Record failed");
    } finally {
      setSaving(false);
    }
  };

  if (!campaign) return <Card className="p-6 text-sm text-muted-foreground">Pick a campaign lane first.</Card>;

  const fmt = (v: number | null) => (v == null ? "—" : v.toLocaleString());
  const fmtLift = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toLocaleString()}`);

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-3" data-testid="yt-metric-form">
        <h3 className="font-medium">Record a capture window</h3>
        <p className="text-xs text-muted-foreground">
          Capture the baseline before outreach, then +24h / +72h / +7d. Lift below is <strong>Observed Lift</strong>
          {" "}(window minus baseline) — not attributed views.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Window</Label>
            <Select value={form.window_label} onValueChange={(v) => setForm({ ...form, window_label: v as YtMetricWindow })}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {YT_METRIC_WINDOWS.map((w) => <SelectItem key={w} value={w}>{WINDOW_LABEL[w]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Impressions</Label>
            <Input type="number" value={form.impressions} onChange={(e) => setForm({ ...form, impressions: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Views</Label>
            <Input type="number" value={form.views} onChange={(e) => setForm({ ...form, views: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Likes</Label>
            <Input type="number" value={form.likes} onChange={(e) => setForm({ ...form, likes: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Comments</Label>
            <Input type="number" value={form.comments} onChange={(e) => setForm({ ...form, comments: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Notes</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <Button onClick={record} disabled={saving}>{saving ? "Saving…" : "Record capture"}</Button>
      </Card>

      <div className="overflow-x-auto border rounded-lg" data-testid="yt-measurement-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Window</th>
              <th className="text-left p-3">Impressions</th>
              <th className="text-left p-3">Views</th>
              <th className="text-left p-3">Likes</th>
              <th className="text-left p-3">Comments</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : (
              <>
                <tr className="border-t bg-muted/20">
                  <td className="p-3 font-medium">Baseline</td>
                  <td className="p-3">{fmt(baseline?.impressions ?? null)}</td>
                  <td className="p-3">{fmt(baseline?.views ?? null)}</td>
                  <td className="p-3">{fmt(baseline?.likes ?? null)}</td>
                  <td className="p-3">{fmt(baseline?.comments ?? null)}</td>
                </tr>
                {windows.map((w) => (
                  <tr key={w.window_label} className="border-t align-top">
                    <td className="p-3 font-medium">{WINDOW_LABEL[w.window_label as YtMetricWindow] ?? w.window_label}</td>
                    <td className="p-3">
                      <div>{fmt(w.impressions)}</div>
                      <div className="text-xs text-muted-foreground">Lift {fmtLift(w.observed_lift.impressions)}</div>
                    </td>
                    <td className="p-3">
                      <div>{fmt(w.views)}</div>
                      <div className="text-xs text-muted-foreground">Lift {fmtLift(w.observed_lift.views)}</div>
                    </td>
                    <td className="p-3">
                      <div>{fmt(w.likes)}</div>
                      <div className="text-xs text-muted-foreground">Lift {fmtLift(w.observed_lift.likes)}</div>
                    </td>
                    <td className="p-3">
                      <div>{fmt(w.comments)}</div>
                      <div className="text-xs text-muted-foreground">Lift {fmtLift(w.observed_lift.comments)}</div>
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Observed Lift = window total − baseline total. Correlation only; no causal attribution is asserted.
      </p>
    </div>
  );
};

export default AdminYouTubeShares;
