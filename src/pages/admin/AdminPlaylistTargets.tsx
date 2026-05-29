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
  const [spotifyStatus, setSpotifyStatus] = useState<{ connected: boolean; reason?: string } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refreshSpotifyStatus = useCallback(async () => {
    try {
      const s = await callHubFn<{ connected: boolean; reason?: string }>("connect_spotify_status", {});
      setSpotifyStatus(s);
    } catch {
      setSpotifyStatus({ connected: false, reason: "status check failed" });
    }
  }, []);

  useEffect(() => {
    refreshSpotifyStatus();
  }, [refreshSpotifyStatus]);

  const connectSpotify = async () => {
    setConnecting(true);
    try {
      const res = await callHubFn<{ auth_url: string }>("connect_spotify_init", {});
      if (!res.auth_url) throw new Error("No auth_url returned");
      const popup = window.open(res.auth_url, "spotify_oauth", "width=600,height=800");
      if (!popup) {
        toast.error("Popup blocked — allow popups for this site and try again.");
        setConnecting(false);
        return;
      }
      const start = Date.now();
      const poll = window.setInterval(async () => {
        if (Date.now() - start > 120_000) {
          window.clearInterval(poll);
          setConnecting(false);
          toast.error("Spotify connect timed out — try again.");
          return;
        }
        try {
          const s = await callHubFn<{ connected: boolean }>("connect_spotify_status", {});
          if (s.connected) {
            window.clearInterval(poll);
            setSpotifyStatus(s);
            setConnecting(false);
            popup.close();
            toast.success("Spotify connected. Live discovery is on.");
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (e) {
      setConnecting(false);
      toast.error(e instanceof Error ? e.message : "Failed to start Spotify connect");
    }
  };

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await callHubFn<{ rows: PlaylistRow[] }>("list_targets", {
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
      await callHubFn("run_playlist_research", {
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
      const res = await callHubFn<{ enriched: number }>("enrich_curator_contacts", {
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
      const res = await callHubFn<{ draft_id: string }>("draft_pitch", {
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
      await callHubFn("deactivate_target", { playlist_id: playlistId });
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

      {spotifyStatus && !spotifyStatus.connected && (
        <Card className="p-4 border-yellow-600/50 bg-yellow-950/20">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="font-medium">Spotify not connected</div>
              <p className="text-sm text-muted-foreground mt-1">
                Live playlist discovery is off until Spotify is connected. Catalog-only results still work.
                {spotifyStatus.reason ? ` (${spotifyStatus.reason})` : ""}
              </p>
            </div>
            <Button type="button" onClick={connectSpotify} disabled={connecting}>
              {connecting ? "Waiting for authorization…" : "Connect Spotify"}
            </Button>
          </div>
        </Card>
      )}

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
