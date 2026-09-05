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
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";
import {
  DNA_STATE_LABEL,
  isEditableDnaState,
  parseLaneList,
  type SongDnaApprovalState,
  type SongDnaVersion,
} from "@/lib/songDna";

type TrackOpt = { id: string; name: string };

const emptyForm = {
  primary_genre: "",
  secondary_genres: "",
  approved_lanes: "",
  excluded_lanes: "",
  mood_tags: "",
  context_tags: "",
  reference_artists: "",
  short_pitch: "",
  bpm_hint: "",
  energy_hint: "",
  sample_declaration: "unknown" as "yes" | "no" | "unknown",
  sync_recommendation: "blocked" as "blocked" | "candidate" | "approved" | "rejected",
  notes: "",
};

const stateVariant = (s: SongDnaApprovalState): "default" | "secondary" | "destructive" | "outline" => {
  if (s === "approved") return "default";
  if (s === "pending_fendi_review") return "outline";
  if (s === "rejected") return "destructive";
  return "secondary";
};

const AdminSongDna: React.FC = () => {
  const [tracks, setTracks] = useState<TrackOpt[]>([]);
  const [rows, setRows] = useState<SongDnaVersion[]>([]);
  const [trackFilter, setTrackFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formTrackId, setFormTrackId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const tracksPromise = callHubFn<{ rows: TrackOpt[] }>("list_tracks").catch((e) => {
        console.warn("list_tracks failed", e);
        return { rows: [] as TrackOpt[] };
      });
      const dnaPromise = callHubFn<{ rows: SongDnaVersion[] }>("list_song_dna", {
        ...(trackFilter !== "all" ? { track_id: trackFilter } : {}),
      });

      const [t, d] = await Promise.all([tracksPromise, dnaPromise]);
      setTracks(t.rows ?? []);
      setRows(d.rows ?? []);
      setLoadError(null);
    } catch (e) {
      const message = (e as Error).message || "Failed to load Song DNA";
      setLoadError(message);
      setRows([]);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [trackFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(
    () => rows.filter((r) => r.approval_state === "pending_fendi_review"),
    [rows],
  );

  const resetForm = () => {
    setForm(emptyForm);
    setFormTrackId("");
    setEditingId(null);
  };

  const bodyFromForm = () => ({
    primary_genre: form.primary_genre.trim() || null,
    secondary_genres: parseLaneList(form.secondary_genres),
    approved_lanes: parseLaneList(form.approved_lanes),
    excluded_lanes: parseLaneList(form.excluded_lanes),
    mood_tags: parseLaneList(form.mood_tags),
    context_tags: parseLaneList(form.context_tags),
    reference_artists: parseLaneList(form.reference_artists),
    short_pitch: form.short_pitch.trim() || null,
    bpm_hint: form.bpm_hint === "" ? null : Number(form.bpm_hint),
    energy_hint: form.energy_hint === "" ? null : Number(form.energy_hint),
    sample_declaration: form.sample_declaration,
    sync_recommendation: form.sync_recommendation,
    notes: form.notes.trim() || null,
  });

  const createDraft = async () => {
    if (!formTrackId) {
      toast.error("Pick a track");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("create_song_dna_draft", { track_id: formTrackId, ...bodyFromForm() });
      toast.success("Song DNA draft created (not approved)");
      resetForm();
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setBusy(true);
    try {
      await callHubFn("update_song_dna_draft", {
        song_dna_version_id: editingId,
        ...bodyFromForm(),
      });
      toast.success("Draft updated");
      resetForm();
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (r: SongDnaVersion) => {
    if (!isEditableDnaState(r.approval_state)) {
      toast.error("Approved / pending versions are immutable — create a new draft");
      return;
    }
    setEditingId(r.id);
    setFormTrackId(r.track_id);
    setForm({
      primary_genre: r.primary_genre ?? "",
      secondary_genres: (r.secondary_genres ?? []).join(", "),
      approved_lanes: (r.approved_lanes ?? []).join(", "),
      excluded_lanes: (r.excluded_lanes ?? []).join(", "),
      mood_tags: (r.mood_tags ?? []).join(", "),
      context_tags: (r.context_tags ?? []).join(", "),
      reference_artists: (r.reference_artists ?? []).join(", "),
      short_pitch: r.short_pitch ?? "",
      bpm_hint: r.bpm_hint == null ? "" : String(r.bpm_hint),
      energy_hint: r.energy_hint == null ? "" : String(r.energy_hint),
      sample_declaration: r.sample_declaration,
      sync_recommendation: r.sync_recommendation,
      notes: r.notes ?? "",
    });
  };

  const submit = async (id: string) => {
    setBusy(true);
    try {
      await callHubFn("submit_song_dna_for_review", { song_dna_version_id: id });
      toast.success("Submitted for Fendi review");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      await callHubFn("approve_song_dna", { song_dna_version_id: id });
      toast.success("Approved — approver recorded from your signed-in admin identity");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    const reason = (rejectReason[id] ?? "").trim();
    if (!reason) {
      toast.error("Rejection reason required");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("reject_song_dna", { song_dna_version_id: id, rejection_reason: reason });
      toast.success("Rejected");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Reject failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Song DNA</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Versioned music identity for campaign activation and sync readiness. Drafts never
          auto-approve — only your signed-in admin identity can approve. Do not invent genre,
          sample, or license facts.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          <Link to="/admin/discovery-profiles" className="underline">
            Discovery profiles
          </Link>{" "}
          and{" "}
          <Link to="/admin/pitch-composer" className="underline">
            Pitch Composer
          </Link>{" "}
          consume the approved version.
        </p>
      </div>

      {pending.length > 0 && (
        <Card className="p-5 space-y-3 border-primary/40">
          <h2 className="font-medium">Pending Fendi review ({pending.length})</h2>
          {pending.map((r) => (
            <div key={r.id} className="flex flex-wrap items-end gap-3 border-t pt-3">
              <div className="min-w-[12rem] flex-1">
                <div className="font-medium">{r.track_name ?? r.track_id}</div>
                <div className="text-xs text-muted-foreground">
                  v{r.version_number} · {r.primary_genre || "no genre"} · sample {r.sample_declaration}
                </div>
              </div>
              <Input
                className="max-w-xs"
                placeholder="Rejection reason"
                value={rejectReason[r.id] ?? ""}
                onChange={(e) => setRejectReason((m) => ({ ...m, [r.id]: e.target.value }))}
              />
              <Button size="sm" disabled={busy} onClick={() => void approve(r.id)}>
                Approve
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void reject(r.id)}>
                Reject
              </Button>
            </div>
          ))}
        </Card>
      )}

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">{editingId ? "Edit draft" : "Create draft"}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Track</Label>
            <Select
              value={formTrackId || undefined}
              onValueChange={setFormTrackId}
              disabled={Boolean(editingId)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select track" />
              </SelectTrigger>
              <SelectContent>
                {tracks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Primary genre</Label>
            <Input
              value={form.primary_genre}
              onChange={(e) => setForm((f) => ({ ...f, primary_genre: e.target.value }))}
              placeholder="e.g. hip_hop_rap — Fendi’s ears, not AI guess"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Approved lanes (comma-separated)</Label>
            <Input
              value={form.approved_lanes}
              onChange={(e) => setForm((f) => ({ ...f, approved_lanes: e.target.value }))}
              placeholder="rap_general, deep_house_groove"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Excluded lanes</Label>
            <Input
              value={form.excluded_lanes}
              onChange={(e) => setForm((f) => ({ ...f, excluded_lanes: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Sample declaration</Label>
            <Select
              value={form.sample_declaration}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, sample_declaration: v as typeof f.sample_declaration }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">unknown</SelectItem>
                <SelectItem value="no">no</SelectItem>
                <SelectItem value="yes">yes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Sync recommendation</Label>
            <Select
              value={form.sync_recommendation}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, sync_recommendation: v as typeof f.sync_recommendation }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blocked">blocked</SelectItem>
                <SelectItem value="candidate">candidate</SelectItem>
                <SelectItem value="approved">approved</SelectItem>
                <SelectItem value="rejected">rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Song-specific short pitch ({"{{pitch}}"} only)</Label>
            <Textarea
              rows={2}
              value={form.short_pitch}
              onChange={(e) => setForm((f) => ({ ...f, short_pitch: e.target.value }))}
              placeholder="Required before submit — never filled from playlist/lane copy"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Context tags</Label>
            <Input
              value={form.context_tags}
              onChange={(e) => setForm((f) => ({ ...f, context_tags: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Reference artists (approved DNA only)</Label>
            <Input
              value={form.reference_artists}
              onChange={(e) => setForm((f) => ({ ...f, reference_artists: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex gap-2">
          {editingId ? (
            <>
              <Button disabled={busy} onClick={() => void saveEdit()}>
                Save draft
              </Button>
              <Button variant="ghost" disabled={busy} onClick={resetForm}>
                Cancel
              </Button>
            </>
          ) : (
            <Button disabled={busy || !formTrackId} onClick={() => void createDraft()}>
              Create draft
            </Button>
          )}
        </div>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Versions</h2>
          <Select value={trackFilter} onValueChange={setTrackFilter}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Filter track" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tracks</SelectItem>
              {tracks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Card className="p-0 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Track</th>
                <th className="text-left p-3">Ver</th>
                <th className="text-left p-3">State</th>
                <th className="text-left p-3">Genre</th>
                <th className="text-left p-3">Sample</th>
                <th className="text-right p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="p-3 text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && loadError && (
                <tr>
                  <td colSpan={6} className="p-3">
                    <div className="space-y-2">
                      <p className="font-medium text-destructive">Song DNA could not be loaded</p>
                      <p className="text-sm text-muted-foreground break-words">{loadError}</p>
                      <Button size="sm" variant="outline" onClick={() => void load()}>
                        Retry
                      </Button>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && !loadError && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-3 text-muted-foreground">
                    No Song DNA versions yet. Create a draft above.
                  </td>
                </tr>
              )}
              {!loading &&
                !loadError &&
                rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-3 font-medium">{r.track_name ?? r.track_id.slice(0, 8)}</td>
                    <td className="p-3 font-mono text-xs">v{r.version_number}</td>
                    <td className="p-3">
                      <Badge variant={stateVariant(r.approval_state)}>
                        {DNA_STATE_LABEL[r.approval_state]}
                      </Badge>
                    </td>
                    <td className="p-3 text-xs">{r.primary_genre || "—"}</td>
                    <td className="p-3 text-xs">{r.sample_declaration}</td>
                    <td className="p-3 text-right space-x-2">
                      {isEditableDnaState(r.approval_state) && (
                        <>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => startEdit(r)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit(r.id)}>
                            Submit
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
};

export default AdminSongDna;
