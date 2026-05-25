import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { callHubFn } from "@/lib/hubApi";

type PlaylistRow = {
  playlist_id: string;
  playlist_name: string;
  curator_name: string | null;
  curator_email: string | null;
  curator_instagram: string | null;
  lane: string | null;
  tier: number | null;
  authenticity_score: number | null;
  fraud_verdict: string | null;
  contact_confidence: number | null;
  pitch_status: string | null;
  follower_count: number | null;
  why_it_fits: string | null;
};

const TRACK_DEFAULT = "Designed For Me (Control)";

const AdminPlaylistTargets: React.FC = () => {
  const [rows, setRows] = useState<PlaylistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackName, setTrackName] = useState(TRACK_DEFAULT);
  const [lane, setLane] = useState("deep_house_groove");
  const [filterLane, setFilterLane] = useState("");
  const [filterTier, setFilterTier] = useState("");
  const [hasEmailOnly, setHasEmailOnly] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: PlaylistRow[] }>("playlist-admin-api", {
        action: "list_targets",
        ...(filterLane ? { lane: filterLane } : {}),
        ...(filterTier ? { tier: Number(filterTier) } : {}),
        ...(hasEmailOnly ? { has_email: true } : {}),
      });
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filterLane, filterTier, hasEmailOnly]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const filtered = useMemo(() => rows, [rows]);

  const runResearch = async () => {
    try {
      await callHubFn("playlist-research", {
        track_name: trackName,
        lane,
        references: ["Drake — Passionfruit", "Channel Tres — Joyful Noise"],
        user_vibe:
          "Chicago deep-house influenced melodic rap, late-night luxury, Kaytranada / Channel Tres adjacent.",
      });
      toast.success("Research complete — refresh list");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const enrichBatch = async () => {
    try {
      const res = await callHubFn<{ enriched: number }>("enrich-curator-contacts", {
        track_name: trackName,
        lane,
        limit: 20,
      });
      toast.success(`Enriched ${res.enriched ?? 0} playlists`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const draftPitch = async (playlistId: string) => {
    setBusyId(playlistId);
    try {
      const res = await callHubFn<{ draft_id: string }>("draft-pitch", {
        playlist_id: playlistId,
        track_name: trackName,
        generated_by: "admin:ui",
      });
      toast.success(`Draft created: ${res.draft_id?.slice(0, 8)}…`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const markAvoid = async (playlistId: string) => {
    setBusyId(playlistId);
    try {
      await callHubFn("playlist-admin-api", { action: "deactivate_target", playlist_id: playlistId });
      toast.success("Marked inactive");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Playlist targets</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Lane-aware discovery, contact enrichment, and pitch drafts (approval required before send).
        </p>
      </div>

      <Card className="p-5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Track</label>
            <Input value={trackName} onChange={(e) => setTrackName(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Lane (research)</label>
            <Input value={lane} onChange={(e) => setLane(e.target.value)} placeholder="deep_house_groove" />
          </div>
          <div className="flex items-end gap-2">
            <Button type="button" onClick={runResearch}>Run research</Button>
            <Button type="button" variant="outline" onClick={enrichBatch}>Enrich contacts</Button>
          </div>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Filter lane</label>
            <Input value={filterLane} onChange={(e) => setFilterLane(e.target.value)} placeholder="deep_house_groove" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Filter tier</label>
            <Input value={filterTier} onChange={(e) => setFilterTier(e.target.value)} placeholder="1 or 2" />
          </div>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={hasEmailOnly} onChange={(e) => setHasEmailOnly(e.target.checked)} />
            Has email
          </label>
          <Button type="button" variant="outline" onClick={fetchRows}>Refresh</Button>
        </div>
      </Card>

      <div className="rounded border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="text-left p-2">Playlist</th>
              <th className="text-left p-2">Curator</th>
              <th className="text-left p-2">Lane</th>
              <th className="text-left p-2">Tier</th>
              <th className="text-left p-2">Auth</th>
              <th className="text-left p-2">Contact</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="p-4 text-muted-foreground">No rows — run research or apply filters.</td></tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.playlist_id} className="border-t">
                  <td className="p-2">
                    <div className="font-medium">{r.playlist_name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{r.why_it_fits}</div>
                  </td>
                  <td className="p-2">{r.curator_name ?? "—"}</td>
                  <td className="p-2">{r.lane ?? "—"}</td>
                  <td className="p-2">{r.tier ?? "—"}</td>
                  <td className="p-2">{r.authenticity_score ?? "—"}</td>
                  <td className="p-2 text-xs">
                    {r.curator_email ? "✉ " : ""}
                    {r.curator_instagram ? "IG @" + r.curator_instagram : ""}
                    {!r.curator_email && !r.curator_instagram ? "—" : ""}
                  </td>
                  <td className="p-2 space-x-1">
                    <Button size="sm" variant="outline" disabled={busyId === r.playlist_id} onClick={() => draftPitch(r.playlist_id)}>
                      Draft
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busyId === r.playlist_id} onClick={() => markAvoid(r.playlist_id)}>
                      Avoid
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default AdminPlaylistTargets;
