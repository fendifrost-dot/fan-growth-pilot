import React, { useCallback, useEffect, useState } from "react";
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

type TrackOpt = { id: string; name: string };
type LyricsRow = {
  id: string;
  track_id: string;
  track_name?: string | null;
  version_number: number;
  source: string;
  status: string;
  plain_text: string;
  notes: string | null;
};

const AdminLyrics: React.FC = () => {
  const [tracks, setTracks] = useState<TrackOpt[]>([]);
  const [rows, setRows] = useState<LyricsRow[]>([]);
  const [trackId, setTrackId] = useState("");
  const [plain, setPlain] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([
        callHubFn<{ rows: TrackOpt[] }>("list_tracks"),
        callHubFn<{ rows: LyricsRow[] }>("list_lyrics", {}),
      ]);
      setTracks(t.rows ?? []);
      setRows(l.rows ?? []);
    } catch (e) {
      toast.error((e as Error).message || "Failed to load lyrics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!trackId || !plain.trim()) {
      toast.error("Track and lyrics text required");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("upsert_lyrics_manual", {
        track_id: trackId,
        plain_text: plain,
        notes: notes.trim() || null,
      });
      toast.success("Lyrics draft saved (manual)");
      setPlain("");
      setNotes("");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const markReady = async (id: string) => {
    setBusy(true);
    try {
      await callHubFn("mark_lyrics_ready", { lyrics_id: id });
      toast.success("Marked ready");
      await load();
    } catch (e) {
      toast.error((e as Error).message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const requestProvider = async () => {
    if (!trackId) {
      toast.error("Pick a track first");
      return;
    }
    setBusy(true);
    try {
      await callHubFn("request_lyrics_provider_job", { track_id: trackId });
      toast.message("Unexpected success — provider should be deferred");
    } catch (e) {
      toast.message((e as Error).message || "Provider deferred (expected)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lyrics</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Manual upload and editable transcriptions. Paid lyric providers are deferred —
          the adapter refuses vendor jobs until Fendi authorizes a budget and provider.
        </p>
      </div>

      <Card className="p-5 space-y-4">
        <h2 className="font-medium">Manual transcription</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Track</Label>
            <Select value={trackId || undefined} onValueChange={setTrackId}>
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
          <div className="space-y-1.5 md:col-span-2">
            <Label>Plain text lyrics</Label>
            <Textarea rows={10} value={plain} onChange={(e) => setPlain(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void save()}>
            Save draft
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void requestProvider()}>
            Request provider job (deferred)
          </Button>
        </div>
      </Card>

      <Card className="p-0 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Track</th>
              <th className="text-left p-3">Ver</th>
              <th className="text-left p-3">Source</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="p-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-3">{r.track_name ?? r.track_id.slice(0, 8)}</td>
                <td className="p-3 font-mono text-xs">v{r.version_number}</td>
                <td className="p-3 text-xs">{r.source}</td>
                <td className="p-3">
                  <Badge variant="secondary">{r.status}</Badge>
                </td>
                <td className="p-3 text-right">
                  {r.status === "draft" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void markReady(r.id)}>
                      Mark ready
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

export default AdminLyrics;
