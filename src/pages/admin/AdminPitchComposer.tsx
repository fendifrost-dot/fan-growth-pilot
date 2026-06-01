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
  spotify_url: string | null;
  apple_music_url: string | null;
  soundcloud_url: string | null;
  track_categories?: { categories: Category | null }[];
};

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
  const [tone, setTone] = useState("warm_personal");
  const [step, setStep] = useState(1);
  const [targetsByMode, setTargetsByMode] = useState<Record<ModeKey, TargetRow[]>>({
    warm_aligned: [],
    new_cold: [],
    all_warm: [],
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mismatchAck, setMismatchAck] = useState<Set<string>>(new Set());
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
      setMismatchAck(new Set());
      setStep(3);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTargets(false);
    }
  };

  const toggleSelect = (row: TargetRow, mode: ModeKey) => {
    const id = row.playlist_id;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (mode === "new_cold" && row._overlap === 0) {
      // require explicit ack when checking zero-overlap in new_cold column
    }
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

  const needsMismatchAck = (row: TargetRow) =>
    row._overlap === 0 && selected.has(row.playlist_id) && !mismatchAck.has(row.playlist_id);

  const createDrafts = async () => {
    if (!trackId || !selectedRows.length) return;

    const unacked = selectedRows.filter(needsMismatchAck);
    if (unacked.length) {
      toast.error("Acknowledge category mismatch for zero-overlap selections");
      return;
    }

    const run = async () => {
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
        try {
          const res = await callHubFn<{
            draft_id: string;
            subject: string;
            body: string;
            error?: string;
          }>("draft_pitch", {
            track_id: trackId,
            playlist_id: r.playlist_id,
            tone,
            override_category_check: r._overlap === 0,
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
                  <label className="flex items-center gap-2 pl-6 text-amber-600">
                    <Checkbox
                      checked={mismatchAck.has(r.playlist_id)}
                      onCheckedChange={(c) => {
                        setMismatchAck((prev) => {
                          const next = new Set(prev);
                          if (c) next.add(r.playlist_id);
                          else next.delete(r.playlist_id);
                          return next;
                        });
                      }}
                    />
                    Category mismatch — pitch anyway
                  </label>
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
        <p className="text-sm text-muted-foreground mt-1">Select a track, pick curators, preview drafts, and send.</p>
      </div>

      {/* Step 1 — Select song */}
      <Card className="p-4 space-y-3">
        <Label>Step 1 — Select song</Label>
        <Select value={trackId} onValueChange={(v) => { setTrackId(v); setStep(1); }}>
          <SelectTrigger><SelectValue placeholder="Choose an active track…" /></SelectTrigger>
          <SelectContent>
            {tracks.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {track && (
          <div className="flex flex-wrap gap-2 items-center text-sm">
            {(track.track_categories ?? []).map((tc, i) =>
              tc.categories ? <Badge key={i} variant="outline">{tc.categories.label}</Badge> : null,
            )}
            {track.spotify_url && <Badge variant="secondary">Spotify</Badge>}
            {track.apple_music_url && <Badge variant="secondary">Apple</Badge>}
            {track.soundcloud_url && <Badge variant="secondary">SoundCloud</Badge>}
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
