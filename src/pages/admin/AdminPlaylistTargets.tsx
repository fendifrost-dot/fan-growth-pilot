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
  curator_submission_url: string | null;
  curator_submission_dm: string | null;
  lane: string | null;
  tier: number | null;
  authenticity_score: number | null;
  fraud_verdict: string | null;
  contact_confidence: number | null;
  submission_method: string | null;
  last_enriched_at: string | null;
  pitch_status: string | null;
  follower_count: number | null;
  why_it_fits: string | null;
};

function ContactCell({ row }: { row: PlaylistRow }) {
  const conf = row.contact_confidence;
  const tip = row.last_enriched_at
    ? `Enriched: ${new Date(row.last_enriched_at).toLocaleString()}`
    : "Not enriched yet";
  const badge =
    conf != null ? (
      <span className="ml-1 text-[10px] px-1 rounded bg-muted text-muted-foreground" title={tip}>
        {conf}
      </span>
    ) : null;

  const method = row.submission_method ?? (row.curator_email ? "email" : null);

  if (method === "email" && row.curator_email) {
    return (
      <span title={tip}>
        ✉️ {row.curator_email}
        {badge}
      </span>
    );
  }
  if (method === "web_form" && row.curator_submission_url) {
    return (
      <a href={row.curator_submission_url} target="_blank" rel="noreferrer" className="underline" title={tip}>
        🔗 Submission form
        {badge}
      </a>
    );
  }
  if (method === "instagram_dm") {
    const handle = (row.curator_submission_dm || row.curator_instagram || "").replace(/^@/, "");
    if (!handle) return <span className="text-muted-foreground">—</span>;
    return (
      <a
        href={`https://www.instagram.com/${handle}/`}
        target="_blank"
        rel="noreferrer"
        title={tip}
      >
        📩 @{handle}
        {badge}
      </a>
    );
  }
  if (row.curator_instagram) {
    const h = row.curator_instagram.replace(/^@/, "");
    return (
      <a href={`https://www.instagram.com/${h}/`} target="_blank" rel="noreferrer" title={tip}>
        IG @{h}
        {badge}
      </a>
    );
  }
  return <span className="text-muted-foreground" title={tip}>—</span>;
}

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
  const [researching, setResearching] = useState(false);

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

  const runResearch = async (quick: boolean) => {
    setResearching(true);
    try {
      const res = await callHubFn<{ live_api_ingested?: number }>("run_playlist_research", {
        track_name: trackName,
        lane,
        quick,
        references: ["Kaytranada", "Channel Tres", "SG Lewis"],
        user_vibe:
          "Chicago deep-house influenced melodic rap, late-night luxury, Kaytranada / Channel Tres adjacent.",
      });
      const n = res.live_api_ingested ?? 0;
      toast.success(
        quick
          ? `Quick research done (${n} discovered via web). Paste emails with Set email where missing.`
          : `Research done (${n} discovered). Run Enrich or Set email, then Draft.`,
      );
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setResearching(false);
    }
  };

  const enrichBatch = async () => {
    try {
      let offset = 0;
      let total = 0;
      let done = false;
      while (!done) {
        const res = await callHubFn<{
          enriched: number;
          done?: boolean;
          next_offset?: number | null;
        }>("enrich_curator_contacts", {
          lane,
          limit: 8,
          offset,
        });
        total += res.enriched ?? 0;
        done = res.done ?? true;
        offset = res.next_offset ?? offset + 8;
        if (done) break;
        toast.message(`Enriched ${total} so far… continuing`);
      }
      toast.success(`Enriched ${total} playlist(s). Use Set email for any still missing.`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const setCuratorEmail = async (playlistId: string) => {
    const email = window.prompt("Curator email for pitching:");
    if (!email?.trim()) return;
    try {
      await callHubFn("patch_target", { playlist_id: playlistId, curator_email: email.trim() });
      toast.success("Email saved");
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const queueDm = async (playlistId: string) => {
    setBusyId(playlistId);
    try {
      await callHubFn("queue_instagram_pitch", {
        playlist_id: playlistId,
        track_name: trackName,
      });
      toast.success("DM queued — copy from social queue / IG app");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
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
          Discovery uses Firecrawl (web). Pitch path: Set email → Draft → Approve on Outreach. See{" "}
          <code className="text-xs">docs/PLAYLIST_PITCH_FAST_PATH.md</code>.
        </p>
      </div>

      <Card className="p-4 border-border/80 bg-muted/20">
        <p className="text-sm">
          <span className="font-medium">Fastest first pitch:</span> pick any row → <strong>Set email</strong> →{" "}
          <strong>Draft</strong> → <strong>/admin/outreach</strong> → Approve &amp; send. Spotify Connect below is
          optional (stats only).
        </p>
      </Card>

      {spotifyStatus && !spotifyStatus.connected && (
        <Card className="p-4 border-muted">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="font-medium text-sm">Spotify account (optional)</div>
              <p className="text-xs text-muted-foreground mt-1">
                For platform stats — not required for playlist discovery.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={connectSpotify} disabled={connecting}>
              {connecting ? "Waiting…" : "Connect Spotify"}
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
          <div className="flex flex-wrap items-end gap-2">
            <Button type="button" disabled={researching} onClick={() => runResearch(true)}>
              {researching ? "Researching…" : "Quick research"}
            </Button>
            <Button type="button" variant="secondary" disabled={researching} onClick={() => runResearch(false)}>
              Full research
            </Button>
            <Button type="button" variant="outline" onClick={enrichBatch}>
              Enrich contacts
            </Button>
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
                  <td className="p-2 text-xs max-w-[180px]">
                    <ContactCell row={r} />
                  </td>
                  <td className="p-2 space-x-1 flex flex-wrap gap-1">
                    <Button size="sm" variant="secondary" onClick={() => setCuratorEmail(r.playlist_id)}>
                      Set email
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === r.playlist_id || r.submission_method !== "email"}
                      title={r.submission_method !== "email" ? "Email channel only" : undefined}
                      onClick={() => draftPitch(r.playlist_id)}
                    >
                      Draft
                    </Button>
                    {r.submission_method === "instagram_dm" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === r.playlist_id}
                        onClick={() => queueDm(r.playlist_id)}
                      >
                        Queue DM
                      </Button>
                    )}
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
