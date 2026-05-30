import React, { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type OutreachStats = {
  fan_email_subscribers: number;
  fan_telegram_subscribers: number;
  playlist_pending_drafts: number;
  playlist_emails_24h: number;
  radio_stations: number;
  radio_with_email: number;
  radio_ready_to_pitch: number;
  radio_emails_24h: number;
  instagram_dm_queue: number;
  ig_roster_mutual?: number;
  ig_roster_total?: number;
  telegram_stats: Record<string, unknown> | null;
};

type DraftRow = {
  id: string;
  playlist_id: string;
  track_name: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  status: string;
};

type CampaignRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
  real_sent: number;
};

type TgSubscriber = {
  id: string;
  telegram_chat_id: string;
  first_name: string | null;
  telegram_username: string | null;
};

type QueueRow = {
  id: string;
  target_url: string;
  draft_text: string | null;
  operator_brief: string | null;
  dm_ref: string | null;
  ig_handle: string | null;
  playlist_id: string | null;
};

type RadioRow = {
  station_id: string;
  station_call_sign: string;
  contact_email: string | null;
  total_spins: number | null;
  pitch_status: string | null;
};

const TRACK_DEFAULT = "Designed For Me (Control)";

const TG_TEMPLATE = `Hey {{first_name}}\\!

New music from Fendi Frost — *Designed For Me \\(Control\\)* is live\\.

Stream: https://rnd\\.fm/track/designed\\-for\\-me\\-control`;

const TAB_VALUES = ["overview", "fan-email", "fan-telegram", "playlist", "radio", "instagram"] as const;

const AdminSendCenter: React.FC = () => {
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const defaultTab = TAB_VALUES.includes(tabParam as typeof TAB_VALUES[number])
    ? (tabParam as typeof TAB_VALUES[number])
    : "overview";

  const [stats, setStats] = useState<OutreachStats | null>(null);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [tgSubs, setTgSubs] = useState<TgSubscriber[]>([]);
  const [igRows, setIgRows] = useState<QueueRow[]>([]);
  const [radioRows, setRadioRows] = useState<RadioRow[]>([]);
  const [trackName, setTrackName] = useState(TRACK_DEFAULT);
  const [busy, setBusy] = useState<string | null>(null);

  // Telegram blast state
  const [tgText, setTgText] = useState(TG_TEMPLATE);
  const [tgTestChatId, setTgTestChatId] = useState("");
  const [tgCampaignId, setTgCampaignId] = useState("");
  const [tgPreview, setTgPreview] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [s, d, camps, radio, ig] = await Promise.all([
        callHubFn<OutreachStats>("get_outreach_stats", {}),
        callHubFn<{ rows: DraftRow[] }>("list_drafts", { statuses: ["pending"] }),
        supabase.from("email_campaign_stats").select("id, name, slug, status, real_sent").order("created_at", { ascending: false }).limit(20),
        callHubFn<{ targets: RadioRow[] }>("get_radio_targets", {}),
        callHubFn<{ rows: QueueRow[] }>("list_social_queue", { status: "pending", limit: 30 }),
      ]);
      setStats(s);
      setDrafts(d.rows ?? []);
      setCampaigns((camps.data ?? []) as CampaignRow[]);
      setRadioRows((radio.targets ?? []).filter((r) => (r.contact_email || "").trim()).slice(0, 15));
      setIgRows(ig.rows ?? []);

      const { data: subs } = await supabase
        .from("telegram_subscribers")
        .select("id, telegram_chat_id, first_name, telegram_username")
        .eq("subscribed", true)
        .order("created_at", { ascending: false })
        .limit(20);
      setTgSubs((subs ?? []) as TgSubscriber[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load send center");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (tgSubs.length > 0 && !tgTestChatId) {
      setTgTestChatId(tgSubs[0].telegram_chat_id);
    }
  }, [tgSubs, tgTestChatId]);

  const approveDraft = async (draftId: string, send: boolean) => {
    setBusy(draftId);
    try {
      const res = await callHubFn<{ sent?: boolean; error?: string }>("approve_draft", {
        draft_id: draftId,
        approved_by: "admin:send-center",
        send_immediately: send,
      });
      if (res.error) toast.error(res.error);
      else if (send) toast.success("Playlist pitch sent");
      else toast.success("Draft approved");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  };

  const tgCall = async (mode: string, extra: Record<string, unknown> = {}) => {
    return callHubFn<Record<string, unknown>>("send_telegram_campaign", {
      mode,
      text: tgText,
      ...extra,
    });
  };

  const tgPreviewMsg = async () => {
    setBusy("tg-preview");
    try {
      const res = await tgCall("preview", { to_first_name: "Fendi" });
      setTgPreview(String(res.text ?? ""));
      toast.success("Preview ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  };

  const tgTestSend = async () => {
    if (!tgTestChatId.trim()) {
      toast.error("Enter a test chat_id");
      return;
    }
    setBusy("tg-test");
    try {
      const res = await tgCall("test", {
        to_chat_id: tgTestChatId.trim(),
        to_first_name: "Fendi",
        campaign_id: tgCampaignId || null,
      });
      const ok = (res.result as { ok?: boolean })?.ok;
      if (ok) toast.success("Telegram test sent");
      else toast.error(JSON.stringify(res.result));
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test send failed");
    } finally {
      setBusy(null);
    }
  };

  const tgBatch = async (dryRun: boolean) => {
    setBusy(dryRun ? "tg-dry" : "tg-batch");
    try {
      const res = await tgCall("batch", {
        campaign_id: tgCampaignId || null,
        batch_label: `send-center-${new Date().toISOString().slice(0, 16)}`,
        filter: { dry_run: dryRun },
      });
      if (dryRun) {
        toast.info(`Dry run: would send to ${res.would_send ?? 0} subscribers`);
      } else {
        toast.success(`Sent ${res.succeeded ?? 0}, failed ${res.failed ?? 0}`);
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Batch failed");
    } finally {
      setBusy(null);
    }
  };

  const sendRadio = async (stationId: string) => {
    if (!confirm("Send radio pitch email?")) return;
    setBusy(stationId);
    try {
      await callHubFn("send_radio_pitch", { station_id: stationId, track_name: trackName });
      toast.success("Radio pitch sent");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Send center</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          All outbound channels in one place: fan email, fan Telegram, playlist curator email, radio email, and Instagram DMs.
        </p>
      </div>

      <Tabs defaultValue={defaultTab} key={defaultTab} className="w-full">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="fan-email">Fan email</TabsTrigger>
          <TabsTrigger value="fan-telegram">Fan Telegram</TabsTrigger>
          <TabsTrigger value="playlist">Playlist email</TabsTrigger>
          <TabsTrigger value="radio">Radio email</TabsTrigger>
          <TabsTrigger value="instagram">Instagram DM</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <StatCard
              title="Fan email blasts"
              stat={`${stats?.fan_email_subscribers ?? "—"} subscribed`}
              desc="Resend campaigns to smart-link contacts"
              to="/admin/campaigns"
              tab="fan-email"
            />
            <StatCard
              title="Fan Telegram"
              stat={`${stats?.fan_telegram_subscribers ?? "—"} subscribed`}
              desc="Inner Circle bot broadcasts (MarkdownV2)"
              to="/admin/send"
              tab="fan-telegram"
            />
            <StatCard
              title="Playlist curator email"
              stat={`${stats?.playlist_pending_drafts ?? 0} pending · ${stats?.playlist_emails_24h ?? 0}/24h`}
              desc="1:1 pitches with cooldown"
              to="/admin/outreach"
              tab="playlist"
            />
            <StatCard
              title="Radio / DJ email"
              stat={`${stats?.radio_with_email ?? 0} w/ email · ${stats?.radio_emails_24h ?? 0}/24h`}
              desc={`${stats?.radio_stations ?? 0} warm stations`}
              to="/admin/radio"
              tab="radio"
            />
            <StatCard
              title="Instagram DM queue"
              stat={`${stats?.instagram_dm_queue ?? 0} pending`}
              desc="Manual paste in IG app"
              to="/admin/ig-queue"
              tab="instagram"
            />
            <StatCard
              title="Discovery"
              stat="Firecrawl"
              desc="Find new playlist targets first"
              to="/admin/playlists"
            />
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>Refresh stats</Button>
        </TabsContent>

        <TabsContent value="fan-email" className="mt-4 space-y-4">
          <Card className="p-5 space-y-3">
            <h2 className="font-medium">Fan email blasts (subscribers)</h2>
            <p className="text-sm text-muted-foreground">
              Batch sends to <code className="text-xs">email_contacts</code> who opted in via smart links.
              Not for curators or radio.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild><Link to="/admin/campaigns">All campaigns</Link></Button>
              <Button variant="outline" asChild><Link to="/admin/contacts">Manage contacts</Link></Button>
            </div>
          </Card>
          <div className="rounded border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3">Campaign</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Sent</th>
                  <th className="text-right p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.length === 0 ? (
                  <tr><td colSpan={4} className="p-4 text-muted-foreground">No campaigns — seed in Supabase or Lovable.</td></tr>
                ) : (
                  campaigns.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="p-3 font-medium">{c.name}</td>
                      <td className="p-3">{c.status}</td>
                      <td className="p-3 text-right">{c.real_sent}</td>
                      <td className="p-3 text-right">
                        <Button size="sm" asChild>
                          <Link to={`/admin/campaigns/${c.slug}`}>Preview · Test · Batch send →</Link>
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="fan-telegram" className="mt-4 space-y-4">
          <Card className="p-5 space-y-4">
            <h2 className="font-medium">Fan Telegram blasts (Inner Circle)</h2>
            <p className="text-xs text-muted-foreground">
              Uses <code>telegram-send-campaign</code>. Text must be Telegram <strong>MarkdownV2</strong> — escape{" "}
              <code>. - ( ) !</code> with backslashes. Token: <code>{`{{first_name}}`}</code>.
            </p>
            <div>
              <label className="text-xs text-muted-foreground">Message (MarkdownV2)</label>
              <Textarea className="mt-1 font-mono text-sm min-h-[140px]" value={tgText} onChange={(e) => setTgText(e.target.value)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Test chat_id</label>
                <Input className="mt-1" value={tgTestChatId} onChange={(e) => setTgTestChatId(e.target.value)} placeholder="Telegram chat id" />
                {tgSubs.length > 0 && (
                  <select
                    className="mt-2 w-full text-sm border rounded px-2 py-1.5 bg-background"
                    value={tgTestChatId}
                    onChange={(e) => setTgTestChatId(e.target.value)}
                  >
                    {tgSubs.map((s) => (
                      <option key={s.id} value={s.telegram_chat_id}>
                        {s.first_name || s.telegram_username || s.telegram_chat_id}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Campaign ID (optional, for dedupe)</label>
                <Input className="mt-1" value={tgCampaignId} onChange={(e) => setTgCampaignId(e.target.value)} placeholder="uuid from email_campaigns" />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!!busy} onClick={tgPreviewMsg}>Preview</Button>
              <Button variant="secondary" disabled={!!busy} onClick={tgTestSend}>Send test</Button>
              <Button variant="outline" disabled={!!busy} onClick={() => tgBatch(true)}>Dry-run batch</Button>
              <Button disabled={!!busy} onClick={() => { if (confirm(`Broadcast to ${stats?.fan_telegram_subscribers ?? "?"} subscribers?`)) tgBatch(false); }}>
                Broadcast to all subscribed
              </Button>
            </div>
            {tgPreview && (
              <pre className="text-xs p-3 bg-muted rounded whitespace-pre-wrap">{tgPreview}</pre>
            )}
            <p className="text-xs text-muted-foreground">
              Active subscribers: <strong>{stats?.fan_telegram_subscribers ?? 0}</strong>
              {stats?.telegram_stats && (
                <> · 30d sends: {String((stats.telegram_stats as Record<string, number>).sends_succeeded_30d ?? "—")}</>
              )}
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="playlist" className="mt-4 space-y-4">
          <Card className="p-5 space-y-3">
            <h2 className="font-medium">Playlist curator email (1:1)</h2>
            <p className="text-sm text-muted-foreground">
              Discover targets first, then draft here or on Playlists. Approve sends one email per curator (90-day cooldown, 10/day cap).
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-xs text-muted-foreground">Track</label>
                <Input className="mt-1 w-56" value={trackName} onChange={(e) => setTrackName(e.target.value)} />
              </div>
              <Button variant="outline" asChild><Link to="/admin/playlists">Find playlists</Link></Button>
              <Button variant="outline" asChild><Link to="/admin/pitch-log">Pitch log</Link></Button>
            </div>
          </Card>
          <h3 className="text-sm font-medium">Pending drafts — quick approve</h3>
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending drafts. Run research → enrich → Draft on Playlists.</p>
          ) : (
            <div className="space-y-2">
              {drafts.map((d) => (
                <Card key={d.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-sm">{d.track_name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">
                      {d.channel} → {d.recipient ?? "—"} · {d.playlist_id}
                    </div>
                    {d.subject && <div className="text-xs mt-1">{d.subject}</div>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/admin/outreach">Edit</Link>
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy === d.id} onClick={() => approveDraft(d.id, false)}>
                      Approve
                    </Button>
                    <Button size="sm" disabled={busy === d.id || d.channel !== "email"} onClick={() => approveDraft(d.id, true)}>
                      Approve &amp; send
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="radio" className="mt-4 space-y-4">
          <Card className="p-5 space-y-3">
            <h2 className="font-medium">Radio / DJ email</h2>
            <p className="text-sm text-muted-foreground">
              Thank-you for spinning + new track pitch. Stations need <code>contact_email</code> patched first.
            </p>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-xs text-muted-foreground">New track</label>
                <Input className="mt-1 w-56" value={trackName} onChange={(e) => setTrackName(e.target.value)} />
              </div>
              <Button variant="outline" asChild><Link to="/admin/radio">Full radio table</Link></Button>
            </div>
          </Card>
          <div className="rounded border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3">Station</th>
                  <th className="text-right p-3">Spins</th>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Send</th>
                </tr>
              </thead>
              <tbody>
                {radioRows.length === 0 ? (
                  <tr><td colSpan={5} className="p-4 text-muted-foreground">No stations with email — patch on Radio page.</td></tr>
                ) : (
                  radioRows.map((r) => (
                    <tr key={r.station_id} className="border-t">
                      <td className="p-3 font-medium">{r.station_call_sign}</td>
                      <td className="p-3 text-right">{r.total_spins ?? 0}</td>
                      <td className="p-3 text-xs">{r.contact_email}</td>
                      <td className="p-3">{r.pitch_status ?? "—"}</td>
                      <td className="p-3 text-right">
                        <Button size="sm" disabled={busy === r.station_id} onClick={() => sendRadio(r.station_id)}>
                          Send
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="instagram" className="mt-4 space-y-4">
          <Card className="p-5 space-y-3">
            <h2 className="font-medium">Instagram DM (manual, 10/day)</h2>
            <p className="text-sm text-muted-foreground">
              Mutual-follow only. Operator brief confirms identity; paste the short message only.
              Roster: {stats?.ig_roster_mutual ?? 0} mutual / {stats?.ig_roster_total ?? 0} tracked.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild><Link to="/admin/playlists">Find playlists with my music</Link></Button>
              <Button variant="outline" asChild><Link to="/admin/ig-roster">IG roster</Link></Button>
              <Button variant="secondary" asChild><Link to="/admin/ig-queue">IG queue ({stats?.instagram_dm_queue ?? 0} pending)</Link></Button>
            </div>
          </Card>
          <div className="rounded border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2">Profile</th>
                  <th className="text-left p-2">REF / message</th>
                  <th className="text-left p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {igRows.length === 0 ? (
                  <tr><td colSpan={3} className="p-4 text-muted-foreground">Queue empty — enrich playlists with IG submission method.</td></tr>
                ) : (
                  igRows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2">
                        <a href={r.target_url} target="_blank" rel="noreferrer" className="underline text-xs">{r.target_url}</a>
                      </td>
                      <td className="p-2 text-xs max-w-md">
                        <div className="text-muted-foreground">{r.dm_ref ?? "—"}</div>
                        <div className="truncate">{r.draft_text ?? "—"}</div>
                      </td>
                      <td className="p-2">
                        <Button size="sm" variant="outline" onClick={() => {
                          navigator.clipboard.writeText(r.draft_text ?? "");
                          toast.success("Copied message only");
                        }}>Copy message</Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

function StatCard({
  title,
  stat,
  desc,
  to,
  tab,
}: {
  title: string;
  stat: string;
  desc: string;
  to: string;
  tab?: string;
}) {
  const href = tab && to === "/admin/send" ? `${to}?tab=${tab}` : to;
  return (
    <Card className="p-4 flex flex-col gap-2">
      <div className="font-medium">{title}</div>
      <div className="text-2xl font-semibold tracking-tight">{stat}</div>
      <p className="text-xs text-muted-foreground flex-1">{desc}</p>
      <Button size="sm" variant="outline" asChild>
        <Link to={href}>Open →</Link>
      </Button>
    </Card>
  );
}

export default AdminSendCenter;
