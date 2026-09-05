import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type TrackRow = { id: string; name: string; status: string };

type GateTrack = {
  id: string;
  name: string;
  has_sample: string | null;
  sync_eligible: boolean;
  approved_song_dna_version_id: string | null;
  sample_declaration_approved_at: string | null;
  sync_approved_at: string | null;
  splits_ready: boolean;
  publishing_ready: boolean;
  assets_ready: boolean;
  unresolved_rights_exception: boolean;
  sample_exception_resolved: boolean;
  sync_eligible_blockers: string[] | null;
  sync_eligible_computed_at: string | null;
};

const AdminSyncGate: React.FC = () => {
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [gate, setGate] = useState<GateTrack | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTracks = useCallback(async () => {
    try {
      const t = await callHubFn<{ rows: TrackRow[] }>("list_tracks");
      setTracks((t.rows ?? []).filter((r) => r.status === "active"));
    } catch (e) {
      toast.error((e as Error).message || "Failed to load tracks");
    }
  }, []);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  const loadGate = useCallback(async (id: string) => {
    if (!id) {
      setGate(null);
      return;
    }
    try {
      const data = await callHubFn<{ track: GateTrack }>("get_track_sync_gate", { track_id: id });
      setGate(data.track);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load sync gate");
      setGate(null);
    }
  }, []);

  useEffect(() => {
    void loadGate(trackId);
  }, [trackId, loadGate]);

  const patch = async (fields: Record<string, unknown>) => {
    if (!trackId) return;
    setBusy(true);
    try {
      const data = await callHubFn<{ sync_eligible: boolean; blockers: string[] }>(
        "update_track_sync_gate",
        { track_id: trackId, ...fields },
      );
      toast.success(
        data.sync_eligible
          ? "Sync-ready (all gates green)"
          : `Still blocked: ${(data.blockers ?? []).join(", ") || "unknown"}`,
      );
      await loadGate(trackId);
    } catch (e) {
      toast.error((e as Error).message || "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const recompute = async () => {
    if (!trackId) return;
    setBusy(true);
    try {
      const data = await callHubFn<{ sync_eligible: boolean; blockers: string[] }>(
        "recompute_track_sync_eligible",
        { track_id: trackId },
      );
      toast.message(
        data.sync_eligible ? "Recomputed: sync-ready" : `Recomputed blockers: ${(data.blockers ?? []).join(", ")}`,
      );
      await loadGate(trackId);
    } catch (e) {
      toast.error((e as Error).message || "Recompute failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sync eligibility gate</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          <code>sync_eligible</code> is never inferred from sample status. Fendi must approve Song DNA,
          sample declaration, and sync; ops mark splits/publishing/assets. Neva also needs{" "}
          <Link className="underline" to="/admin/private-licenses">private license evidence</Link>.
        </p>
      </div>

      <Card className="p-5 space-y-3">
        <Label>Track</Label>
        <Select value={trackId} onValueChange={setTrackId}>
          <SelectTrigger><SelectValue placeholder="Choose track…" /></SelectTrigger>
          <SelectContent>
            {tracks.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void recompute()} disabled={!trackId || busy}>
          Recompute sync_eligible
        </Button>
      </Card>

      {gate && (
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{gate.name}</h2>
            {gate.sync_eligible ? (
              <Badge>Sync-ready</Badge>
            ) : (
              <Badge variant="outline">Not sync-ready</Badge>
            )}
            <Badge variant="secondary">sample={gate.has_sample ?? "unknown"}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            DNA: {gate.approved_song_dna_version_id?.slice(0, 8) ?? "—"} · Computed:{" "}
            {gate.sync_eligible_computed_at
              ? new Date(gate.sync_eligible_computed_at).toLocaleString()
              : "—"}
          </p>
          {(gate.sync_eligible_blockers ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(gate.sync_eligible_blockers ?? []).map((b) => (
                <Badge key={b} variant="destructive">{b}</Badge>
              ))}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Fendi sample declaration approved</Label>
              <Switch
                checked={Boolean(gate.sample_declaration_approved_at)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ sample_declaration_approved: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Fendi sync approved</Label>
              <Switch
                checked={Boolean(gate.sync_approved_at)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ sync_approved: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Splits ready</Label>
              <Switch
                checked={Boolean(gate.splits_ready)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ splits_ready: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Publishing ready</Label>
              <Switch
                checked={Boolean(gate.publishing_ready)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ publishing_ready: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Audio assets ready</Label>
              <Switch
                checked={Boolean(gate.assets_ready)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ assets_ready: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Unresolved rights exception</Label>
              <Switch
                checked={Boolean(gate.unresolved_rights_exception)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ unresolved_rights_exception: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border rounded p-3">
              <Label>Sample exception resolved</Label>
              <Switch
                checked={Boolean(gate.sample_exception_resolved)}
                disabled={busy}
                onCheckedChange={(v) => void patch({ sample_exception_resolved: v })}
              />
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default AdminSyncGate;
