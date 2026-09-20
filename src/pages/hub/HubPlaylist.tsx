import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Send, Target, ShieldCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { callHubFn } from "@/lib/hubApi";
import { PageHeader, HubLoading, HubEmpty, StatTile } from "@/components/hub/HubPrimitives";
import { toast } from "sonner";

type DraftRow = {
  id: string;
  playlist_id: string;
  track_name: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  status: string;
};

type PitchRow = {
  id: string;
  track_name: string;
  curator_email: string | null;
  method: string | null;
  status: string | null;
  pitched_at: string | null;
  reply_received: boolean | null;
  placed: boolean | null;
  placement_status: string | null;
};

type PitchStats = {
  sent: number;
  replied: number;
  placed: number;
  pending: number;
  reply_rate_pct: number;
  placement_rate_pct: number;
};

type ReviewRow = {
  playlist_id: string;
  playlist_name: string | null;
  curator_name: string | null;
  curator_email: string | null;
  platform: string | null;
  verification_status: string;
  bounce_count: number | null;
};

const statusVariant = (status: string | null | undefined) => {
  const s = (status || "").toLowerCase();
  if (s.includes("sent") || s.includes("placed") || s.includes("approved")) return "default";
  if (s.includes("error") || s.includes("reject") || s.includes("bounce")) return "destructive";
  return "secondary";
};

const HubPlaylist: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [pitches, setPitches] = useState<PitchRow[]>([]);
  const [stats, setStats] = useState<PitchStats | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p, s, r] = await Promise.all([
        callHubFn<{ rows: DraftRow[] }>("list_drafts", { statuses: ["pending"] }).catch(
          () => ({ rows: [] as DraftRow[] }),
        ),
        callHubFn<{ rows: PitchRow[] }>("list_pitches", { limit: 100 }).catch(() => ({
          rows: [] as PitchRow[],
        })),
        callHubFn<{ totals: PitchStats }>("pitch_stats_summary", {}).catch(() => ({
          totals: null as PitchStats | null,
        })),
        callHubFn<{ rows: ReviewRow[] }>("list_unverified_targets", {}).catch(() => ({
          rows: [] as ReviewRow[],
        })),
      ]);
      setDrafts(d.rows ?? []);
      setPitches(p.rows ?? []);
      setStats(s.totals ?? null);
      setReviews(r.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load playlist ops");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Playlist ops"
        description="Track curator pitches end-to-end — pending sends, live opportunities, and the verification queue. Approvals and sends stay gated in the operator tools."
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            ↻ Refresh
          </Button>
        }
      />

      {loading ? (
        <HubLoading label="Loading playlist ops…" />
      ) : (
        <Tabs defaultValue="sends">
          <TabsList>
            <TabsTrigger value="sends" className="gap-1.5">
              <Send className="w-4 h-4" /> Sends
              {drafts.length > 0 && <Badge variant="secondary">{drafts.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="opportunities" className="gap-1.5">
              <Target className="w-4 h-4" /> Opportunities
            </TabsTrigger>
            <TabsTrigger value="approvals" className="gap-1.5">
              <ShieldCheck className="w-4 h-4" /> Approvals
              {reviews.length > 0 && <Badge variant="secondary">{reviews.length}</Badge>}
            </TabsTrigger>
          </TabsList>

          {/* SENDS — pending pitch drafts */}
          <TabsContent value="sends" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/send">
                  Open Send center <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {drafts.length === 0 ? (
              <HubEmpty
                icon={Send}
                title="No pending sends"
                description="Curator pitch drafts awaiting approval will show up here."
              />
            ) : (
              <div className="space-y-2">
                {drafts.map((d) => (
                  <Card
                    key={d.id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{d.track_name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {d.channel} · {d.recipient || "no recipient"}
                      </p>
                    </div>
                    <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* OPPORTUNITIES — pitch log */}
          <TabsContent value="opportunities" className="space-y-4 mt-4">
            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatTile label="Sent" value={stats.sent} />
                <StatTile label="Replied" value={stats.replied} sub={`${stats.reply_rate_pct}%`} />
                <StatTile
                  label="Placed"
                  value={stats.placed}
                  sub={`${stats.placement_rate_pct}%`}
                />
                <StatTile label="Pending" value={stats.pending} />
              </div>
            )}
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/pitch-log">
                  Open pitch log <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {pitches.length === 0 ? (
              <HubEmpty
                icon={Target}
                title="No pitch activity yet"
                description="Once curator pitches go out, replies and placements will appear here."
              />
            ) : (
              <div className="space-y-2">
                {pitches.slice(0, 50).map((p) => (
                  <Card
                    key={p.id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{p.track_name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {p.curator_email || "—"} · {p.method || "email"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.placed && <Badge>Placed</Badge>}
                      {p.reply_received && !p.placed && <Badge variant="secondary">Replied</Badge>}
                      <Badge variant={statusVariant(p.status)}>{p.status || "—"}</Badge>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* APPROVALS — verification queue */}
          <TabsContent value="approvals" className="space-y-4 mt-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <Link to="/admin/playlists/review">
                  Open review queue <ArrowRight className="w-4 h-4 ml-1" />
                </Link>
              </Button>
            </div>
            {reviews.length === 0 ? (
              <HubEmpty
                icon={ShieldCheck}
                title="Nothing awaiting approval"
                description="Curator targets that need verification before they're pitchable will appear here."
              />
            ) : (
              <div className="space-y-2">
                {reviews.map((r) => (
                  <Card
                    key={r.playlist_id}
                    className="p-4 flex items-center justify-between gap-3 bg-card/50 border-border"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {r.playlist_name || "Untitled playlist"}
                      </p>
                      <p className="text-sm text-muted-foreground truncate">
                        {r.curator_email || r.curator_name || "no contact"} ·{" "}
                        {r.platform || "unknown"}
                      </p>
                    </div>
                    <Badge variant={statusVariant(r.verification_status)}>
                      {r.verification_status}
                    </Badge>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};

export default HubPlaylist;
