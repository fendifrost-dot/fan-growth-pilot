import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
  submission_cost: string | null;
  is_paid: boolean | null;
  verification_status: string | null;
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
  research_context?: {
    source?: string;
    featuring_tracks?: string[];
    sfa_streams?: number;
    sfa_listeners?: number;
    sfa_date_added?: string | null;
  } | null;
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

function CostCell({ row }: { row: PlaylistRow }) {
  const cost = row.is_paid === true ? "paid" : (row.submission_cost ?? "unknown");
  if (cost === "paid") {
    return <span className="text-[10px] uppercase rounded bg-red-500/15 text-red-600 px-1.5 py-0.5">Paid</span>;
  }
  if (cost === "free") {
    return <span className="text-[10px] uppercase rounded bg-emerald-500/15 text-emerald-600 px-1.5 py-0.5">Free</span>;
  }
  if (cost === "tip_appreciated") {
    return <span className="text-[10px] uppercase rounded bg-amber-500/15 text-amber-600 px-1.5 py-0.5" title="Tip appreciated, not required">Tip</span>;
  }
  return <span className="text-muted-foreground">—</span>;
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
  const [costFilter, setCostFilter] = useState<"" | "free" | "paid">("");
  const [pitchableOnly, setPitchableOnly] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [spotifyStatus, setSpotifyStatus] = useState<{ connected: boolean; reason?: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [researching, setResearching] = useState(false);
  const [discoveringPlacements, setDiscoveringPlacements] = useState(false);
  const [placementOnly, setPlacementOnly] = useState(false);
  const [importingSfa, setImportingSfa] = useState(false);
  const [sfaPeriod, setSfaPeriod] = useState("1year");
  const [sfaResolveUrls, setSfaResolveUrls] = useState(false);
  const [sfaDeactivateMissing, setSfaDeactivateMissing] = useState(false);

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
            toast.success("Spotify connected (stats only — playlist discovery uses Firecrawl web search).");
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
        ...(costFilter ? { cost_filter: costFilter } : {}),
        ...(pitchableOnly ? { pitchable_only: true } : {}),
        ...(placementOnly ? { placement_only: true } : {}),
      });
      setRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filterLane, filterTier, hasEmailOnly, costFilter, pitchableOnly, placementOnly]);

  const discoverPlacements = async () => {
    setDiscoveringPlacements(true);
    try {
      const res = await callHubFn<{
        found: number;
        verified: number;
        ingested: number;
        skipped: Record<string, number>;
      }>("discover_spotify_placements", {
        track_name: trackName,
        lane,
        references: ["Kaytranada", "Channel Tres", "SG Lewis"],
      });
      toast.success(
        `Placements: ${res.ingested} ingested (${res.verified} verified / ${res.found} found). Run Enrich → Queue IG batch.`,
      );
      setPlacementOnly(true);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscoveringPlacements(false);
    }
  };

  const importSfaCsv = async (file: File) => {
    setImportingSfa(true);
    try {
      const csv_text = await file.text();
      const res = await callHubFn<{
        parsed: number;
        ingested: number;
        updated: number;
        skipped: Record<string, number>;
      }>("import_spotify_for_artists_csv", {
        csv_text,
        period_label: sfaPeriod.trim() || "import",
        lane: filterLane || lane,
        references: ["Kaytranada", "Channel Tres", "SG Lewis"],
        resolve_urls: sfaResolveUrls,
        deactivate_missing: sfaDeactivateMissing,
      });
      const skip = res.skipped
        ? Object.entries(res.skipped).filter(([, n]) => (n ?? 0) > 0).map(([k, n]) => `${k} ${n}`).join(" · ")
        : "";
      toast.success(
        `SFA import: ${res.ingested} new, ${res.updated} updated (${res.parsed} rows)${skip ? `. Skipped: ${skip}` : ""}`,
      );
      setPlacementOnly(true);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImportingSfa(false);
    }
  };

  const queueIgBatch = async () => {
    try {
      const res = await callHubFn<{ queued: number; remaining_today: number; skipped?: Record<string, string> }>(
        "queue_ig_outreach_batch",
        {
          track_name: trackName || undefined,
          auto_match_track: !trackName,
          lane: filterLane || lane,
          placement_only: true,
          engagement_type: "thank_and_pitch",
          require_mutual: true,
          limit: 10,
        },
      );
      const skipN = res.skipped ? Object.keys(res.skipped).length : 0;
      toast.success(
        `Queued ${res.queued} IG DMs (${res.remaining_today} left).${skipN ? ` Skipped ${skipN} (roster/mutual).` : ""}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const filtered = useMemo(() => {
    return [...rows].sort(
      (a, b) => (b.contact_confidence ?? 0) - (a.contact_confidence ?? 0),
    );
  }, [rows]);

  const runResearch = async (quick: boolean) => {
    setResearching(true);
    try {
      const res = await callHubFn<{
        live_api_ingested?: number;
        discovery_skips?: Record<string, number>;
      }>("run_playlist_research", {
        track_name: trackName,
        lane,
        quick,
        references: ["Kaytranada", "Channel Tres", "SG Lewis"],
        user_vibe:
          "Chicago deep-house influenced melodic rap, late-night luxury, Kaytranada / Channel Tres adjacent.",
      });
      const n = res.live_api_ingested ?? 0;
      const sk = res.discovery_skips;
      const skipParts = sk
        ? Object.entries(sk)
            .filter(([, v]) => (v ?? 0) > 0)
            .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
            .join(" · ")
        : "";
      toast.success(
        quick
          ? `Quick research: ${n} ingested${skipParts ? ` · skipped: ${skipParts}` : ""}`
          : `Research: ${n} ingested${skipParts ? ` · skipped: ${skipParts}` : ""}. Enrich or Set email, then Draft.`,
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
      const totals = { curator_email: 0, routed_instagram_dm: 0, curator_linktree: 0 };
      while (!done) {
        const res = await callHubFn<{
          enriched: number;
          done?: boolean;
          next_offset?: number | null;
          fields_added?: Record<string, number>;
        }>("enrich_curator_contacts", { lane, limit: 8, offset });
        total += res.enriched ?? 0;
        const fa = res.fields_added ?? {};
        totals.curator_email += fa.curator_email ?? 0;
        totals.routed_instagram_dm += fa.routed_instagram_dm ?? 0;
        totals.curator_linktree += fa.curator_linktree ?? 0;
        done = res.done ?? true;
        offset = res.next_offset ?? offset + 8;
        if (!done) toast.message(`Enriching… ${total} rows processed`);
      }
      toast.success(
        `Enrich done: ${total} rows · +${totals.curator_email} emails · +${totals.routed_instagram_dm} IG queue · see /admin/ig-queue`,
      );
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

  const reconcileLane = async () => {
    const laneKey = filterLane || lane;
    if (!laneKey) {
      toast.error("Set filter lane or research lane first");
      return;
    }
    setReconciling(true);
    try {
      const res = await callHubFn<{
        deactivated_count?: number;
        dry_run?: boolean;
      }>("reconcile_lane_targets", { lane: laneKey, dry_run: false });
      toast.success(`Reconciled lane: ${res.deactivated_count ?? 0} row(s) deactivated`);
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(false);
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
        <Link to="/admin" className="text-xs text-muted-foreground hover:underline">← Command center</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">Find playlists & pitch curators</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Step 1–2 happen here. Step 3–4 on{" "}
          <Link to="/admin/outreach" className="underline font-medium">Send pitches</Link>.
          Fan list blasts are separate:{" "}
          <Link to="/admin/campaigns" className="underline">Fan blasts</Link>.
        </p>
      </div>

      <Card className="p-4 border-primary/20 bg-primary/5">
        <ol className="text-sm space-y-2 list-decimal list-inside">
          <li><strong>Find playlists</strong> — Quick or Full research (Firecrawl web search)</li>
          <li><strong>Enrich contacts</strong> — pull emails / route IG DMs to queue</li>
          <li><strong>Set email</strong> on a row → <strong>Draft</strong> (or Queue DM for Instagram)</li>
          <li>
            <Link to="/admin/outreach" className="underline font-medium">Approve &amp; send</Link> — one curator email
            at a time (90-day cooldown per playlist)
          </li>
        </ol>
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

      <Card className="p-5 space-y-4 border-emerald-500/30">
        <h2 className="text-sm font-medium">Spotify for Artists — playlist report (CSV)</h2>
        <p className="text-xs text-muted-foreground">
          Export from Spotify for Artists → Playlists → download CSV. Import once, then re-upload weekly to refresh
          streams/listeners. Skips Spotify algorithmic playlists (Radio, Discover Weekly, etc.).
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Report label</label>
            <Input value={sfaPeriod} onChange={(e) => setSfaPeriod(e.target.value)} placeholder="1year" />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={sfaResolveUrls}
              onChange={(e) => setSfaResolveUrls(e.target.checked)}
            />
            Resolve Spotify URLs (slower, uses Firecrawl)
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={sfaDeactivateMissing}
              onChange={(e) => setSfaDeactivateMissing(e.target.checked)}
            />
            Deactivate rows missing from this file
          </label>
        </div>
        <div>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={importingSfa}
            className="text-sm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importSfaCsv(f);
              e.target.value = "";
            }}
          />
          {importingSfa && <p className="text-xs text-muted-foreground mt-2">Importing…</p>}
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <h2 className="text-sm font-medium">Step 1–2: Discovery &amp; enrich</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Track to pitch</label>
            <Input value={trackName} onChange={(e) => setTrackName(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Lane (research)</label>
            <Input value={lane} onChange={(e) => setLane(e.target.value)} placeholder="deep_house_groove" />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="button" disabled={researching} onClick={() => runResearch(true)} title="Faster Firecrawl pass">
              {researching ? "Searching…" : "Find playlists (quick)"}
            </Button>
            <Button type="button" variant="secondary" disabled={researching} onClick={() => runResearch(false)} title="Deeper discovery">
              {researching ? "Searching…" : "Find playlists (full)"}
            </Button>
            <Button type="button" variant="outline" onClick={enrichBatch}>
              Enrich contacts
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={discoveringPlacements}
              onClick={discoverPlacements}
              title="Find Spotify playlists that already feature your music"
            >
              {discoveringPlacements ? "Scanning…" : "Find playlists with my music"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" asChild>
            <Link to="/admin/outreach">Review drafts &amp; send →</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/pitch-log">Pitch log</Link>
          </Button>
          <Button variant="secondary" size="sm" onClick={queueIgBatch} title="Requires mutual flags on IG roster">
            Queue 10 IG DMs (mutual)
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/ig-roster">IG roster</Link>
          </Button>
        </div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="text-sm font-medium">Step 3: Targets table</h2>
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
          <div className="flex flex-col pb-2">
            <label className="text-xs text-muted-foreground">Cost</label>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={costFilter}
              onChange={(e) => setCostFilter(e.target.value as "" | "free" | "paid")}
            >
              <option value="">All</option>
              <option value="free">Free</option>
              <option value="paid">Paid</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={pitchableOnly} onChange={(e) => setPitchableOnly(e.target.checked)} />
            Pitchable only
          </label>
          <label className="flex items-center gap-2 text-sm pb-2">
            <input type="checkbox" checked={placementOnly} onChange={(e) => setPlacementOnly(e.target.checked)} />
            Already features me
          </label>
          <Button type="button" variant="outline" onClick={fetchRows}>Refresh</Button>
          <Button type="button" variant="secondary" disabled={reconciling} onClick={reconcileLane}>
            {reconciling ? "Reconciling…" : "Reconcile lane"}
          </Button>
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
              <th className="text-left p-2">Cost</th>
              <th className="text-left p-2">Contact</th>
              <th className="text-left p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="p-4 text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="p-4 text-muted-foreground">No rows — run research or apply filters.</td></tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.playlist_id} className="border-t">
                  <td className="p-2">
                    <div className="font-medium">{r.playlist_name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{r.why_it_fits}</div>
                    {(r.research_context?.source === "spotify_placement" ||
                      r.research_context?.source === "spotify_for_artists_csv") && (
                      <div className="text-[10px] text-emerald-700 dark:text-emerald-400 mt-0.5">
                        ✓ Placement
                        {r.research_context.source === "spotify_for_artists_csv" &&
                          r.research_context.sfa_streams != null &&
                          ` · ${r.research_context.sfa_streams} streams`}
                        {r.research_context.featuring_tracks?.[0] &&
                          r.research_context.source !== "spotify_for_artists_csv" &&
                          ` · ${r.research_context.featuring_tracks[0]}`}
                      </div>
                    )}
                  </td>
                  <td className="p-2">{r.curator_name ?? "—"}</td>
                  <td className="p-2">{r.lane ?? "—"}</td>
                  <td className="p-2">{r.tier ?? "—"}</td>
                  <td className="p-2">{r.authenticity_score ?? "—"}</td>
                  <td className="p-2">
                    <CostCell row={r} />
                  </td>
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
