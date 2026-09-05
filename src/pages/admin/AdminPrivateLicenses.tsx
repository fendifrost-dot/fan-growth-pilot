import React, { useCallback, useEffect, useState } from "react";
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

type TrackRow = { id: string; name: string; status: string };
type LicenseRow = {
  id: string;
  track_id: string;
  label: string;
  storage_path: string | null;
  notes: string | null;
  created_at: string;
};

const AdminPrivateLicenses: React.FC = () => {
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [rows, setRows] = useState<LicenseRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [label, setLabel] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [filterTrackId, setFilterTrackId] = useState("all");

  const load = useCallback(async () => {
    try {
      const [t, lic] = await Promise.all([
        callHubFn<{ rows: TrackRow[] }>("list_tracks"),
        callHubFn<{ rows: LicenseRow[] }>("list_private_licenses", {
          track_id: filterTrackId !== "all" ? filterTrackId : undefined,
        }),
      ]);
      setTracks((t.rows ?? []).filter((r) => r.status === "active"));
      setRows(lic.rows ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load private licenses");
    }
  }, [filterTrackId]);

  useEffect(() => {
    void load();
  }, [load]);

  const register = async () => {
    if (!trackId || !label.trim()) {
      toast.error("Track and label are required");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("register_private_license", {
        track_id: trackId,
        label: label.trim(),
        storage_path: storagePath.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success("License evidence registered (metadata only — upload the file to vault storage separately)");
      setLabel("");
      setStoragePath("");
      setNotes("");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Register failed");
    } finally {
      setBusy(false);
    }
  };

  const trackName = (id: string) => tracks.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Private license vault</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Register evidence pointers for private licenses (e.g. Neva Too Much Prada). Do not invent
          license facts — only record paths/labels for files Fendi actually holds. File bytes stay in
          private storage; this table is the operator index.
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          Song DNA sync candidacy for licensed tracks checks this register.{" "}
          <Link className="underline" to="/admin/song-dna">Song DNA →</Link>
        </p>
      </div>

      <Card className="p-5 space-y-3">
        <Label>Register evidence</Label>
        <Select value={trackId} onValueChange={setTrackId}>
          <SelectTrigger><SelectValue placeholder="Track…" /></SelectTrigger>
          <SelectContent>
            {tracks.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div>
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Master use license PDF" />
        </div>
        <div>
          <Label>Storage path (optional)</Label>
          <Input
            value={storagePath}
            onChange={(e) => setStoragePath(e.target.value)}
            placeholder="private-vault/neva/…"
          />
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </div>
        <Button onClick={() => void register()} disabled={busy}>
          {busy ? "Saving…" : "Register evidence"}
        </Button>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <Label>Filter</Label>
            <Select value={filterTrackId} onValueChange={setFilterTrackId}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tracks</SelectItem>
                {tracks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={() => void load()}>Refresh</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="p-2">Track</th>
                <th className="p-2">Label</th>
                <th className="p-2">Path</th>
                <th className="p-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {!rows.length && (
                <tr><td colSpan={4} className="p-4 text-muted-foreground">No evidence registered yet.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="p-2">{trackName(r.track_id)}</td>
                  <td className="p-2 font-medium">{r.label}</td>
                  <td className="p-2 font-mono text-xs">
                    {r.storage_path ? <Badge variant="outline">{r.storage_path}</Badge> : "—"}
                  </td>
                  <td className="p-2 text-xs">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export default AdminPrivateLicenses;
