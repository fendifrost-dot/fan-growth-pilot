import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Megaphone, Pause, Play, Square } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";
import type { SongDnaVersion } from "@/lib/songDna";

interface CampaignStats {
  sent: number;
  sent_today: number;
  replies: number;
  placements: number;
  targets_remaining: number;
  last_sent_at: string | null;
}

interface CampaignRow {
  id: string;
  track_id: string;
  track_name: string;
  smart_link_id: string | null;
  smart_link_slug: string | null;
  smart_link_active: boolean;
  status: "draft" | "active" | "paused" | "ended";
  daily_target: number;
  notes: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  stats: CampaignStats;
}

interface TrackOption {
  id: string;
  name: string;
  has_pitch_copy: boolean;
  category_count: number;
  open_campaign_id: string | null;
  open_campaign_status: string | null;
}

interface SmartLinkOption {
  id: string;
  slug: string;
  title: string;
  is_active: boolean;
}

/** Human labels for the guardrail's `missing` keys, with where to go fix each. */
const MISSING_LABELS: Record<string, { label: string; fixTo: string; fixLabel: string }> = {
  smart_link: {
    label: "No live smart link selected",
    fixTo: "/admin",
    fixLabel: "Manage smart links",
  },
  category: {
    label: "No category/genre assigned to this song",
    fixTo: "/admin/categories",
    fixLabel: "Assign categories",
  },
  short_pitch: {
    label: "No pitch copy written for this song",
    fixTo: "/admin/catalogue",
    fixLabel: "Write pitch copy",
  },
  approved_song_dna: {
    label: "No approved Song DNA version for this track",
    fixTo: "/admin/song-dna",
    fixLabel: "Song DNA",
  },
  song_dna_version_id: {
    label: "Select an approved Song DNA version before activating",
    fixTo: "/admin/song-dna",
    fixLabel: "Song DNA",
  },
  admin_jwt: {
    label: "Sign in as admin — activation records your user id as Fendi approver",
    fixTo: "/auth",
    fixLabel: "Sign in",
  },
};

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");

const AdminPitchPortal: React.FC = () => {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [tracks, setTracks] = useState<TrackOption[]>([]);
  const [smartLinks, setSmartLinks] = useState<SmartLinkOption[]>([]);
  const [approvedDna, setApprovedDna] = useState<SongDnaVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Create form
  const [trackId, setTrackId] = useState("");
  const [smartLinkId, setSmartLinkId] = useState("");
  const [dailyTarget, setDailyTarget] = useState(20);
  const [notes, setNotes] = useState("");
  const [missing, setMissing] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, t, dna] = await Promise.all([
        callHubFn<{ rows: CampaignRow[] }>("list_campaigns", { status: "all" }),
        callHubFn<{ rows: TrackOption[]; smart_links: SmartLinkOption[] }>(
          "list_campaignable_tracks",
        ),
        callHubFn<{ rows: SongDnaVersion[] }>("list_song_dna", {}).catch(() => ({ rows: [] })),
      ]);
      setCampaigns(c.rows ?? []);
      setTracks(t.rows ?? []);
      setSmartLinks(t.smart_links ?? []);
      setApprovedDna((dna.rows ?? []).filter((r) => r.approval_state === "approved"));
    } catch (e) {
      toast.error((e as Error).message || "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => campaigns.filter((c) => c.status === "active"), [campaigns]);
  const drafts = useMemo(() => campaigns.filter((c) => c.status === "draft"), [campaigns]);
  const history = useMemo(
    () => campaigns.filter((c) => c.status === "paused" || c.status === "ended"),
    [campaigns],
  );

  // Tracks without an open campaign are the only ones you can create for.
  const available = useMemo(() => tracks.filter((t) => !t.open_campaign_id), [tracks]);
  const selectedTrack = useMemo(() => tracks.find((t) => t.id === trackId), [tracks, trackId]);

  const resetForm = () => {
    setTrackId("");
    setSmartLinkId("");
    setDailyTarget(20);
    setNotes("");
    setMissing(null);
  };

  const create = async () => {
    if (!trackId) {
      toast.error("Pick a song first");
      return;
    }
    setBusy(true);
    setMissing(null);
    try {
      await callHubFn("create_campaign", {
        track_id: trackId,
        smart_link_id: smartLinkId || null,
        daily_target: dailyTarget,
        notes: notes.trim() || null,
      });
      toast.success(`Draft campaign created for “${selectedTrack?.name ?? "track"}”`);
      resetForm();
      await load();
    } catch (e) {
      // The backend returns the guardrail's `missing` list; surface it inline so
      // the artist knows exactly what to fill in rather than seeing a bare error.
      const msg = (e as Error).message || "Failed to create campaign";
      if (msg.includes("not fully configured")) {
        const cfg = await callHubFn<{ config?: { missing: string[] } }>("check_campaign_config", {
          track_id: trackId,
          smart_link_id: smartLinkId || null,
        }).catch(() => null);
        setMissing(cfg?.config?.missing ?? ["smart_link"]);
        toast.error("This song isn't ready to pitch yet");
      } else {
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const patch = async (campaignId: string, body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await callHubFn("update_campaign", { campaign_id: campaignId, ...body });
      toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Megaphone className="h-5 w-5" /> Pitch Portal
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          The only place a song becomes pitchable. Nothing is ever pitched because it's in the
          catalogue or has a smart link — a song goes out <strong>only</strong> while it has an
          active campaign here. Start a campaign to pitch a song; pause or end it to stop.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Create a campaign                                                 */}
      {/* ---------------------------------------------------------------- */}
      <Card className="p-5 space-y-4">
        <div>
          <h2 className="font-medium">Start a new campaign</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Pick a song and create a <strong>draft</strong>. Activation is a separate step that
            requires approved Song DNA and Fendi’s signed-in admin identity (derived server-side).
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Song</Label>
            <Select value={trackId} onValueChange={(v) => { setTrackId(v); setMissing(null); }}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a song from your catalogue" />
              </SelectTrigger>
              <SelectContent>
                {available.length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    Every song already has a campaign
                  </div>
                )}
                {available.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Smart link to pitch</Label>
            <Select value={smartLinkId} onValueChange={(v) => { setSmartLinkId(v); setMissing(null); }}>
              <SelectTrigger>
                <SelectValue placeholder="Pick the live smart link for this song" />
              </SelectTrigger>
              <SelectContent>
                {smartLinks.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.title} — /{l.slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Daily target</Label>
            <Input
              type="number"
              min={1}
              max={200}
              value={dailyTarget}
              onChange={(e) => setDailyTarget(Number(e.target.value) || 20)}
            />
            <p className="text-xs text-muted-foreground">
              Pitches per day for this song. Per-song, not shared across campaigns.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why you're pitching this now, angle, anything to remember later"
            />
          </div>
        </div>

        {/* Readiness hints — shown before you even try, from the picker data */}
        {selectedTrack && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant={selectedTrack.has_pitch_copy ? "secondary" : "destructive"}>
              {selectedTrack.has_pitch_copy ? "Pitch copy ✓" : "Pitch copy missing"}
            </Badge>
            <Badge variant={selectedTrack.category_count > 0 ? "secondary" : "destructive"}>
              {selectedTrack.category_count > 0
                ? `${selectedTrack.category_count} categor${selectedTrack.category_count === 1 ? "y" : "ies"} ✓`
                : "No category assigned"}
            </Badge>
            <Badge variant={smartLinkId ? "secondary" : "destructive"}>
              {smartLinkId ? "Smart link ✓" : "No smart link selected"}
            </Badge>
          </div>
        )}

        {missing && missing.length > 0 && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Fill these in before this song can be pitched
            </div>
            <ul className="space-y-1 text-xs">
              {missing.map((m) => {
                const info = MISSING_LABELS[m];
                return (
                  <li key={m} className="flex items-center gap-2">
                    <span>• {info?.label ?? m}</span>
                    {info && (
                      <Link to={info.fixTo} className="underline text-muted-foreground">
                        {info.fixLabel}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={create} disabled={busy || !trackId}>
            Create draft campaign
          </Button>
          {trackId && (
            <Button variant="ghost" onClick={resetForm} disabled={busy}>
              Clear
            </Button>
          )}
        </div>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Draft campaigns                                                   */}
      {/* ---------------------------------------------------------------- */}
      <div className="space-y-3">
        <h2 className="font-medium">
          Draft campaigns{" "}
          <span className="text-muted-foreground font-normal text-sm">({drafts.length})</span>
        </h2>
        {!loading && drafts.length === 0 && (
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">
              No drafts. New campaigns always start here before Fendi activation.
            </p>
          </Card>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {drafts.map((c) => (
            <Card key={c.id} className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{c.track_name}</div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Created {fmtDate(c.created_at)}
                  </p>
                </div>
                <Badge variant="secondary">draft</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Activation freezes Song DNA, pitch copy, and smart-link snapshot. Approver is
                your signed-in admin user id — not a free-text field.{" "}
                <Link to="/admin/song-dna" className="underline">
                  Manage Song DNA
                </Link>
              </p>
              {(() => {
                const dna = approvedDna.find((d) => d.track_id === c.track_id);
                return (
                  <div className="text-xs">
                    {dna ? (
                      <span>
                        Approved DNA: <span className="font-mono">v{dna.version_number}</span>{" "}
                        ({dna.primary_genre || "genre unset"})
                      </span>
                    ) : (
                      <span className="text-destructive">
                        No approved Song DNA for this track — approve one before activating.
                      </span>
                    )}
                  </div>
                );
              })()}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  disabled={busy || !approvedDna.some((d) => d.track_id === c.track_id)}
                  onClick={() => {
                    const dna = approvedDna.find((d) => d.track_id === c.track_id);
                    if (!dna) {
                      toast.error("Approved Song DNA required");
                      return;
                    }
                    void patch(
                      c.id,
                      { status: "active", song_dna_version_id: dna.id },
                      `Activated “${c.track_name}”`,
                    );
                  }}
                >
                  Activate
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => patch(c.id, { status: "ended" }, `Ended draft “${c.track_name}”`)}
                >
                  End draft
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Active campaigns                                                  */}
      {/* ---------------------------------------------------------------- */}
      <div className="space-y-3">
        <h2 className="font-medium">
          Active campaigns{" "}
          <span className="text-muted-foreground font-normal text-sm">({active.length})</span>
        </h2>

        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && active.length === 0 && (
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">
              No active campaigns — nothing is being pitched right now. Start one above.
            </p>
          </Card>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {active.map((c) => {
            const pct = Math.min(100, Math.round((c.stats.sent_today / Math.max(1, c.daily_target)) * 100));
            return (
              <Card key={c.id} className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{c.track_name}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Started {fmtDate(c.started_at)}
                      {c.smart_link_slug && (
                        <>
                          {" · "}
                          <a
                            className="underline"
                            href={`https://links.fendifrost.com/${c.smart_link_slug}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            /{c.smart_link_slug}
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                  <Badge>active</Badge>
                </div>

                {!c.smart_link_active && (
                  <div className="flex items-center gap-2 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Smart link is no longer live — pitches will be blocked.
                  </div>
                )}

                <div className="grid grid-cols-4 gap-3 text-center">
                  {[
                    ["Sent", c.stats.sent],
                    ["Replies", c.stats.replies],
                    ["Placements", c.stats.placements],
                    ["Targets left", c.stats.targets_remaining],
                  ].map(([label, val]) => (
                    <div key={String(label)}>
                      <div className="text-lg font-semibold font-mono">{val}</div>
                      <div className="text-[11px] text-muted-foreground">{label}</div>
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Today</span>
                    <span className="font-mono">
                      {c.stats.sent_today} / {c.daily_target}
                    </span>
                  </div>
                  <Progress value={pct} />
                </div>

                {c.notes && <p className="text-xs text-muted-foreground italic">{c.notes}</p>}

                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => patch(c.id, { status: "paused" }, `Paused “${c.track_name}”`)}
                  >
                    <Pause className="h-3.5 w-3.5 mr-1" /> Pause
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => patch(c.id, { status: "ended" }, `Ended “${c.track_name}”`)}
                  >
                    <Square className="h-3.5 w-3.5 mr-1" /> End
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* History                                                           */}
      {/* ---------------------------------------------------------------- */}
      <div className="space-y-3">
        <h2 className="font-medium">
          Campaign history{" "}
          <span className="text-muted-foreground font-normal text-sm">({history.length})</span>
        </h2>

        <Card className="p-5">
          <div className="rounded border overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3">Song</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Sent</th>
                  <th className="text-right p-3">Replies</th>
                  <th className="text-right p-3">Placements</th>
                  <th className="text-left p-3">Started</th>
                  <th className="text-left p-3">Ended</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="p-3 text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && history.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-3 text-muted-foreground">
                      No paused or ended campaigns yet
                    </td>
                  </tr>
                )}
                {history.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="p-3 font-medium">{c.track_name}</td>
                    <td className="p-3 text-xs">
                      <span className={c.status === "paused" ? "text-amber-600" : "text-muted-foreground"}>
                        {c.status}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-xs">{c.stats.sent}</td>
                    <td className="p-3 text-right font-mono text-xs">{c.stats.replies}</td>
                    <td className="p-3 text-right font-mono text-xs">{c.stats.placements}</td>
                    <td className="p-3 text-xs text-muted-foreground">{fmtDate(c.started_at)}</td>
                    <td className="p-3 text-xs text-muted-foreground">{fmtDate(c.ended_at)}</td>
                    <td className="p-3 text-right">
                      {c.status === "paused" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => patch(c.id, { status: "active" }, `Resumed “${c.track_name}”`)}
                        >
                          <Play className="h-3.5 w-3.5 mr-1" /> Resume
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default AdminPitchPortal;
