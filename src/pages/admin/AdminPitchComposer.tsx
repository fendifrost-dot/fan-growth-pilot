import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Send, Loader2 } from "lucide-react";
import { callHubFn } from "@/lib/hubApi";

type Category = { id: string; slug: string; label: string; family: string };
type TrackRow = {
  id: string;
  name: string;
  status: string;
  default_tone: string;
  short_pitch?: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  soundcloud_url: string | null;
  track_categories?: { categories: Category | null }[];
};

type SongDnaRow = {
  id: string;
  track_id: string;
  version_number: number;
  approval_state: string;
  primary_genre: string | null;
  secondary_genres?: string[];
  approved_lanes?: string[];
  excluded_lanes?: string[];
  mood_tags?: string[];
  context_tags?: string[];
  reference_artists?: string[];
  short_pitch?: string | null;
};

type CampaignOpt = { id: string; name?: string; title?: string; status?: string; track_id?: string };

type TargetRow = {
  playlist_id: string;
  playlist_name: string;
  curator_name: string | null;
  platform: string;
  tier: number | null;
  follower_count: number | null;
  _overlap: number;
  _warm: boolean;
  playlist_categories?: { category_id: string }[];
};

type DraftPreview = {
  playlist_id: string;
  playlist_name: string;
  draft_id?: string;
  subject?: string;
  body?: string;
  status: "pending" | "drafted" | "approved" | "sent" | "failed" | "skipped";
  error?: string;
  override_subject?: string;
  override_body?: string;
};

const TONE_OPTIONS = [
  { value: "warm_personal", label: "Warm & Personal" },
  { value: "casual_friendly", label: "Casual & Friendly" },
  { value: "business_formal", label: "Business Formal" },
  { value: "hyped_energetic", label: "Hyped & Energetic" },
];

const MODES = [
  { key: "warm_aligned", label: "Warm + aligned", desc: "Prior placements with category overlap" },
  { key: "new_cold", label: "New cold", desc: "Never pitched, matching categories" },
  { key: "all_warm", label: "All warm", desc: "Every prior placement (any category)" },
] as const;

type ModeKey = typeof MODES[number]["key"];

const AdminPitchComposer: React.FC = () => {
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignOpt[]>([]);
  const [approvedDna, setApprovedDna] = useState<SongDnaRow | null>(null);
  const [tone, setTone] = useState("warm_personal");
  const [step, setStep] = useState(1);
  const [targetsByMode, setTargetsByMode] = useState<Record<ModeKey, TargetRow[]>>({
    warm_aligned: [],
    new_cold: [],
    all_warm: [],
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [drafts, setDrafts] = useState<DraftPreview[]>([]);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [testMode, setTestMode] = useState(true);
  const [confirmAllWarm, setConfirmAllWarm] = useState(false);
  const [pendingDraftAction, setPendingDraftAction] = useState<(() => void) | null>(null);
  const [editingDraft, setEditingDraft] = useState<string | null>(null);

  const track = useMemo(() => tracks.find((t) => t.id === trackId), [tracks, trackId]);

  const loadTracks = useCallback(async () => {
    try {
      const t = await callHubFn<{ rows: TrackRow[] }>("list_tracks");
      setTracks((t.rows ?? []).filter((r) => r.status === "active"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  useEffect(() => {
    if (!trackId) {
      setApprovedDna(null);
      setCampaigns([]);
      setCampaignId("");
      return;
    }
    void (async () => {
      try {
        const [dna, camps] = await Promise.all([
          callHubFn<{ rows: SongDnaRow[] }>("list_song_dna", { track_id: trackId }),
          callHubFn<{ campaigns?: CampaignOpt[]; rows?: CampaignOpt[] }>("list_campaigns").catch(() => ({
            campaigns: [],
          })),
        ]);
        const approved = (dna.rows ?? []).find((r) => r.approval_state === "approved") ?? null;
        setApprovedDna(approved);
        const all = camps.campaigns ?? camps.rows ?? [];
        const forTrack = all.filter((c) => !c.track_id || c.track_id === trackId);
        setCampaigns(forTrack);
        setCampaignId((prev) => (forTrack.some((c) => c.id === prev) ? prev : forTrack[0]?.id ?? ""));
      } catch {
        setApprovedDna(null);
      }
    })();
  }, [trackId]);

  useEffect(() => {
    if (track?.default_tone) setTone(track.default_tone);
  }, [track?.id, track?.default_tone]);

  const fetchTargets = async () => {
    if (!trackId) return;
    setLoadingTargets(true);
    try {
      const results = await Promise.all(
        MODES.map(async (m) => {
          const data = await callHubFn<{ rows: TargetRow[] }>("recommend_targets_for_track", {
            track_id: trackId,
            mode: m.key,
            limit: 50,
          });
          return [m.key, data.rows ?? []] as const;
        }),
      );
      const map = { warm_aligned: [], new_cold: [], all_warm: [] } as Record<ModeKey, TargetRow[]>;
      for (const [k, rows] of results) map[k] = rows;
      setTargetsByMode(map);
      setSelected(new Set());
      setStep(3);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTargets(false);
    }
  };

  const toggleSelect = (row: TargetRow, _mode: ModeKey) => {
    const id = row.playlist_id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedRows = useMemo(() => {
    const all = [...targetsByMode.warm_aligned, ...targetsByMode.new_cold, ...targetsByMode.all_warm];
    const byId = new Map<string, TargetRow>();
    for (const r of all) byId.set(r.playlist_id, r);
    return Array.from(selected).map((id) => byId.get(id)).filter(Boolean) as TargetRow[];
  }, [selected, targetsByMode]);

  const hasAllWarmSelection = useMemo(() => {
    const warmIds = new Set(targetsByMode.all_warm.map((r) => r.playlist_id));
    return selectedRows.some((r) => warmIds.has(r.playlist_id) && r._overlap === 0);
  }, [selectedRows, targetsByMode.all_warm]);

  const createDrafts = async () => {
    if (!trackId || !selectedRows.length) return;

    const run = async () => {
      if (!trackId) {
        toast.error("Select a track first");
        return;
      }
      if (!campaignId) {
        toast.error("Select an active campaign — required for exact operational identity");
        return;
      }
      if (!approvedDna) {
        toast.error("No Fendi-approved Song DNA for this track — approve DNA before drafting");
        return;
      }
      setDrafting(true);
      setStep(4);
      const previews: DraftPreview[] = selectedRows.map((r) => ({
        playlist_id: r.playlist_id,
        playlist_name: r.playlist_name,
        status: "pending",
      }));
      setDrafts(previews);

      for (let i = 0; i < selectedRows.length; i++) {
        const r = selectedRows[i];
        const lane = (r as TargetRow & { lane?: string }).lane;
        const excluded = new Set((approvedDna.excluded_lanes ?? []).map((s) => s.toLowerCase()));
        const approved = new Set((approvedDna.approved_lanes ?? []).map((s) => s.toLowerCase()));
        if (lane && excluded.has(String(lane).toLowerCase())) {
          previews[i] = {
            ...previews[i],
            status: "failed",
            error: `Lane "${lane}" is excluded by approved Song DNA — change DNA, not this request.`,
          };
          setDrafts([...previews]);
          continue;
        }
        if (lane && approved.size > 0 && !approved.has(String(lane).toLowerCase())) {
          previews[i] = {
            ...previews[i],
            status: "failed",
            error: `Lane "${lane}" is not in approved Song DNA approved_lanes.`,
          };
          setDrafts([...previews]);
          continue;
        }
        try {
          const res = await callHubFn<{
            draft_id: string;
            subject: string;
            body: string;
            error?: string;
          }>("draft_pitch", {
            track_id: trackId,
            playlist_id: r.playlist_id,
            campaign_id: campaignId,
            song_dna_version_id: approvedDna.id,
            tone,
          });
          previews[i] = {
            ...previews[i],
            draft_id: res.draft_id,
            subject: res.subject,
            body: res.body,
            status: "drafted",
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          previews[i] = { ...previews[i], status: "failed", error: msg };
        }
        setDrafts([...previews]);
      }
      setDrafting(false);
    };

    if (hasAllWarmSelection) {
      setPendingDraftAction(() => run);
      setConfirmAllWarm(true);
    } else {
      await run();
    }
  };

  const approveOne = async (d: DraftPreview, skip = false) => {
    if (!d.draft_id) return;
    if (skip) {
      setDrafts((prev) => prev.map((x) => x.playlist_id === d.playlist_id ? { ...x, status: "skipped" } : x));
      return;
    }
    try {
      if (d.override_subject || d.override_body) {
        await callHubFn("update_draft", {
          draft_id: d.draft_id,
          subject: d.override_subject ?? d.subject,
          body: d.override_body ?? d.body,
        });
      }
      await callHubFn("approve_draft", {
        draft_id: d.draft_id,
        send_immediately: false,
      });
      setDrafts((prev) => prev.map((x) => x.playlist_id === d.playlist_id ? { ...x, status: "approved" } : x));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const sendAll = async () => {
    setSending(true);
    setStep(5);
    for (const d of drafts) {
      if (d.status === "skipped" || d.status === "failed" || d.status === "sent") continue;
      if (!d.draft_id) continue;
      try {
        if (d.override_subject || d.override_body) {
          await callHubFn("update_draft", {
            draft_id: d.draft_id,
            subject: d.override_subject ?? d.subject,
            body: d.override_body ?? d.body,
          });
        }
        await callHubFn("approve_draft", {
          draft_id: d.draft_id,
          send_immediately: true,
          test_mode: testMode,
          test_email: testMode ? "fendifrost@gmail.com" : undefined,
        });
        setDrafts((prev) => prev.map((x) => x.playlist_id === d.playlist_id ? { ...x, status: "sent" } : x));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setDrafts((prev) => prev.map((x) => x.playlist_id === d.playlist_id ? { ...x, status: "failed", error: msg } : x));
      }
    }
    setSending(false);
    toast.success(testMode ? "Test sends complete" : "Send batch complete");
  };

  const TargetColumn = ({ mode }: { mode: ModeKey }) => {
    const meta = MODES.find((m) => m.key === mode)!;
    const rows = targetsByMode[mode];
    return (
      <Card className="p-3 flex-1 min-w-0">
        <h3 className="font-medium text-sm">{meta.label}</h3>
        <p className="text-xs text-muted-foreground mb-2">{meta.desc}</p>
        <ScrollArea className="h-64">
          <div className="space-y-2 pr-2">
            {rows.map((r) => (
              <div key={r.playlist_id} className="border rounded p-2 text-xs space-y-1">
                <label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox
                    checked={selected.has(r.playlist_id)}
                    onCheckedChange={() => toggleSelect(r, mode)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium block">{r.playlist_name}</span>
                    <span className="text-muted-foreground">{r.curator_name ?? "—"}</span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-1 pl-6">
                  <Badge variant="outline">{r.platform}</Badge>
                  {r.tier != null && <Badge variant="secondary">T{r.tier}</Badge>}
                  {r.follower_count != null && <Badge variant="outline">{r.follower_count.toLocaleString()} followers</Badge>}
                  <Badge variant={r._overlap > 0 ? "default" : "destructive"}>{r._overlap}/5 overlap</Badge>
                </div>
                {mode === "new_cold" && r._overlap === 0 && selected.has(r.playlist_id) && (
                  <p className="pl-6 text-amber-700 text-[11px]">
                    Zero category overlap — server still enforces Song DNA compatibility; UI ack does not override.
                  </p>
                )}
              </div>
            ))}
            {!rows.length && <p className="text-muted-foreground text-xs">No matches</p>}
          </div>
        </ScrollArea>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Send className="h-6 w-6" /> Pitch Composer
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track → approved Song DNA → compatible directions → campaign. Exact identities are required.
        </p>
      </div>

      {/* Step 1 — Select song */}
      <Card className="p-4 space-y-3">
        <Label>Step 1 — Select exact track</Label>
        <Select value={trackId} onValueChange={(v) => { setTrackId(v); setStep(1); }}>
          <SelectTrigger><SelectValue placeholder="Choose an active track…" /></SelectTrigger>
          <SelectContent>
            {tracks.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {track && (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant="outline">ID {track.id.slice(0, 8)}…</Badge>
              {(track.track_categories ?? []).map((tc, i) =>
                tc.categories ? <Badge key={i} variant="outline">{tc.categories.label}</Badge> : null,
              )}
            </div>
            {approvedDna ? (
              <div className="rounded-md border p-3 space-y-1 text-xs bg-muted/30">
                <div className="font-medium">Approved Song DNA v{approvedDna.version_number}</div>
                <div>Primary genre: {approvedDna.primary_genre || "—"}</div>
                <div>Secondary: {(approvedDna.secondary_genres ?? []).join(", ") || "—"}</div>
                <div>Mood: {(approvedDna.mood_tags ?? []).join(", ") || "—"}</div>
                <div>Context: {(approvedDna.context_tags ?? []).join(", ") || "—"}</div>
                <div>Refs: {(approvedDna.reference_artists ?? []).join(", ") || "—"}</div>
                <div>Approved lanes: {(approvedDna.approved_lanes ?? []).join(", ") || "—"}</div>
                <div>Excluded lanes: {(approvedDna.excluded_lanes ?? []).join(", ") || "—"}</div>
                <div className="pt-1">Pitch: {approvedDna.short_pitch || track.short_pitch || "—"}</div>
              </div>
            ) : (
              <p className="text-amber-700 text-xs">
                No approved Song DNA — approve one in{" "}
                <a className="underline" href="/admin/song-dna">Song DNA</a> before drafting.
              </p>
            )}
            <div className="space-y-1.5 max-w-md">
              <Label>Campaign (required)</Label>
              <Select value={campaignId || undefined} onValueChange={setCampaignId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select active campaign…" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || c.title || c.id.slice(0, 8)}
                      {c.status ? ` (${c.status})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </Card>

      {/* Step 2 — Tone */}
      {trackId && (
        <Card className="p-4 space-y-3">
          <Label>Step 2 — Confirm tone</Label>
          <Select value={tone} onValueChange={setTone}>
            <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {TONE_OPTIONS.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={fetchTargets} disabled={loadingTargets}>
            {loadingTargets ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Load recommendations →
          </Button>
        </Card>
      )}

      {/* Step 3 — Three buckets */}
      {step >= 3 && (
        <div className="space-y-3">
          <Label>Step 3 — Select curators ({selected.size} selected)</Label>
          <div className="flex flex-col lg:flex-row gap-3">
            <TargetColumn mode="warm_aligned" />
            <TargetColumn mode="new_cold" />
            <TargetColumn mode="all_warm" />
          </div>
          <Button onClick={createDrafts} disabled={!selected.size || drafting}>
            Preview drafts for {selected.size} curator{selected.size !== 1 ? "s" : ""}
          </Button>
        </div>
      )}

      {/* Step 4 — Preview */}
      {step >= 4 && drafts.length > 0 && (
        <Card className="p-4 space-y-3">
          <Label>Step 4 — Preview drafts</Label>
          <ScrollArea className="h-96">
            <div className="space-y-4 pr-4">
              {drafts.map((d) => (
                <Card key={d.playlist_id} className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">{d.playlist_name}</span>
                    <Badge variant={d.status === "sent" ? "default" : d.status === "failed" ? "destructive" : "secondary"}>
                      {d.status}
                    </Badge>
                  </div>
                  {d.error && <p className="text-xs text-destructive mb-2">{d.error}</p>}
                  {d.subject && (
                    <>
                      <p className="text-xs font-medium">Subject</p>
                      {editingDraft === d.playlist_id ? (
                        <Input
                          value={d.override_subject ?? d.subject}
                          onChange={(e) => setDrafts((prev) => prev.map((x) =>
                            x.playlist_id === d.playlist_id ? { ...x, override_subject: e.target.value } : x,
                          ))}
                          className="mb-2 text-xs"
                        />
                      ) : (
                        <p className="text-xs mb-2">{d.override_subject ?? d.subject}</p>
                      )}
                      <p className="text-xs font-medium">Body</p>
                      {editingDraft === d.playlist_id ? (
                        <Textarea
                          value={d.override_body ?? d.body ?? ""}
                          onChange={(e) => setDrafts((prev) => prev.map((x) =>
                            x.playlist_id === d.playlist_id ? { ...x, override_body: e.target.value } : x,
                          ))}
                          rows={8}
                          className="text-xs font-mono"
                        />
                      ) : (
                        <pre className="text-xs whitespace-pre-wrap bg-muted p-2 rounded max-h-40 overflow-y-auto">
                          {d.override_body ?? d.body}
                        </pre>
                      )}
                    </>
                  )}
                  {d.status === "drafted" && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="outline" onClick={() => setEditingDraft(editingDraft === d.playlist_id ? null : d.playlist_id)}>
                        {editingDraft === d.playlist_id ? "Done edit" : "Edit"}
                      </Button>
                      <Button size="sm" onClick={() => approveOne(d)}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => approveOne(d, true)}>Skip</Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </ScrollArea>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Switch checked={testMode} onCheckedChange={setTestMode} id="test-mode" />
              <Label htmlFor="test-mode" className="text-sm">Test mode → fendifrost@gmail.com</Label>
            </div>
            <Button onClick={() => { setDrafts((prev) => prev.map((d) => d.status === "drafted" ? { ...d, status: "approved" as const } : d)); }}>
              Approve all drafted
            </Button>
            <Button variant="secondary" onClick={sendAll} disabled={sending}>
              {sending ? "Sending…" : "Send all approved →"}
            </Button>
          </div>
        </Card>
      )}

      <AlertDialog open={confirmAllWarm} onOpenChange={setConfirmAllWarm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send to all warm curators?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  About to pitch <strong>{track?.name}</strong> to {selected.size} curator(s) across categories that may not match.
                </p>
                <ul className="list-disc pl-4 space-y-1">
                  {selectedRows.filter((r) => r._overlap === 0).slice(0, 8).map((r) => (
                    <li key={r.playlist_id}>{r.playlist_name} — overlap 0/5</li>
                  ))}
                </ul>
                <p>Are you sure?</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmAllWarm(false); pendingDraftAction?.(); setPendingDraftAction(null); }}>
              Yes, send
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AdminPitchComposer;
